import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import findCacheDir from "find-cache-dir";
import {AsyncOrSync} from "ts-essentials";
import {isMainThread, BroadcastChannel, threadId} from "node:worker_threads";
import { strict as assert } from "node:assert";
import {ValueOf} from "ts-essentials";
import {Observable, firstValueFrom} from "rxjs";
import {share, filter, first, tap} from "rxjs/operators";
import util from "node:util";
import debug from "debug";
import stream from "node:stream";
import {ReadableStream, WritableStream} from "node:stream/web";
import {xxhash64} from "hash-wasm";

const log = debug("with-file-cache");

export const fastHash = (x: string | Buffer) => xxhash64(Buffer.from(x));

// https://stackoverflow.com/a/72891118
const readStreamToBuffer = async (stream: ReadableStream) => {
	const buffers = [] as Buffer[];

	for await (const data of stream) {
		buffers.push(data);
	}

	return Buffer.concat(buffers);
}

type CacheKeyElement = string | number | Buffer | (() => AsyncOrSync<string | number | Buffer>);

type CalcCacheKey <F extends (...args: any[]) => any> = (...params: Parameters<F>) => AsyncOrSync<Array<AsyncOrSync<CacheKeyElement>> | CacheKeyElement>;
type Serialize <F extends (...args: any[]) => any> = (result: Awaited<ReturnType<F>>, writeable: WritableStream) => Promise<unknown>;
type Deserialize <F extends (...args: any[]) => any> = (stream: ReadableStream) => Promise<Awaited<ReturnType<F>>> | Awaited<ReturnType<F>>;
type Options<T extends (...args: any[]) => any> = {
	calcCacheKey: CalcCacheKey<T>
	serialize?: undefined,
	deserialize?: undefined,
} | {
	calcCacheKey: CalcCacheKey<T>,
	serialize: Serialize<T>,
	deserialize: Deserialize<T>,
}


const {defaultSerializer, defaultDeserializer} = (() => {
	const DEFAULT_SERIALIZATION_BUFFER = Buffer.from("[[BUFFER]]", "utf8");
	const DEFAULT_SERIALIZATION_JS = Buffer.from("[[JS]]", "utf8");

	const defaultSerializer = <T> (result: T, writeable: WritableStream): Promise<void> => {
		const buffer = Buffer.isBuffer(result) ?
				Buffer.concat([DEFAULT_SERIALIZATION_BUFFER, result]) :
				Buffer.concat([DEFAULT_SERIALIZATION_JS, Buffer.from(JSON.stringify({val: result}))]);
		return stream.promises.pipeline(
			stream.Readable.from(buffer),
			stream.Writable.fromWeb(writeable),
		)
	}

	const defaultDeserializer = async <T> (stream: ReadableStream): Promise<T> => {
		const serialized = await readStreamToBuffer(stream);
		if (serialized.length >= DEFAULT_SERIALIZATION_BUFFER.length && serialized.compare(DEFAULT_SERIALIZATION_BUFFER, 0, DEFAULT_SERIALIZATION_BUFFER.length, 0, DEFAULT_SERIALIZATION_BUFFER.length) === 0) {
			return serialized.subarray(DEFAULT_SERIALIZATION_BUFFER.length) as T;
		}else {
			return JSON.parse(serialized.subarray(DEFAULT_SERIALIZATION_JS.length).toString("utf8")).val as T;
		}
	};

	return {
		defaultSerializer,
		defaultDeserializer,
	};
})();

export const withFileCache = (() => {
	const cacheDir = (async () => {
		const cacheDir = findCacheDir({name: "with-file-cache"})!;

		await fs.mkdir(cacheDir, {recursive: true});

		return cacheDir;
	})();
	const memoryCache = (() => {
		const cache = new Map<string, WeakRef<any>>();
		const registry = new FinalizationRegistry((key: string) => {
			if (!cache.get(key)?.deref()) {
				cache.delete(key);
			}
		});
		return {
			get: (key: string) => {
				return cache.get(key)?.deref()?.value;
			},
			set: (key: string, value: any) => {
				const valueObj = {value};
				cache.set(key, new WeakRef(valueObj));
				registry.register(valueObj, key);
			}
		}
	})();
	type Coordinator = {
		task(cacheKey: string, serialize: Serialize<typeof fn> | undefined, deserialize: Deserialize<typeof fn> | undefined, fn: any): Promise<any>,
	};
	const coordinators = {} as {[broadcastChannelName: string]: Coordinator};

	const FORCE_REFETCH = Symbol();
	const allowedTypes = ["start", "finish", "inprogress", "finished", "startack", "finish_error"] as const;
	return ({baseKey, broadcastChannelName} : {baseKey?: () => AsyncOrSync<string>, broadcastChannelName?: string}) => {
		const coordinator = (() => {
			const effectiveBroadcastChannelName = broadcastChannelName ?? "with-file-cache";
			if(coordinators[effectiveBroadcastChannelName] === undefined) {
				const inProgress = {} as {[i: string]: any};
				const bc = new BroadcastChannel(effectiveBroadcastChannelName);
				bc.unref();
				const $bc = new Observable<{type: ValueOf<typeof allowedTypes>, cacheKey: string}>((subscriber) => {
					const handler = (message: any) => {
						assert(allowedTypes.includes(message.data.type), `message.data.type is outside the allowed values: ${message.data.type}`);
						assert(typeof message.data.cacheKey === "string", `message.data.cacheKey is not string: ${message.data.cacheKey}`);
						debug("with-file-cache:broadcastchannel")("data", message.data, "mainThread", isMainThread, "threadId", threadId);
						subscriber.next(message.data);
					};
					(bc as any as EventTarget).addEventListener("message", handler);
					return () => {
						(bc as any as EventTarget).removeEventListener("message", handler);
					}
				}).pipe(share());
				const coordinator: Coordinator = {
					task: (cacheKey, serialize, deserialize, fn) => {
						log("new task", "cacheKey", cacheKey, " inprogress", inProgress, "mainThread", isMainThread, "threadId", threadId);
						if (inProgress[cacheKey] === undefined) {
							const memoryCachedValue = memoryCache.get(cacheKey);
							if (memoryCachedValue !== undefined) {
								return memoryCachedValue as Promise<Awaited<ReturnType<typeof fn>>>;
							}
							return inProgress[cacheKey] = (async () => {
								const cacheFile = path.join(await cacheDir, cacheKey);
								try {
									const result = await (async () => {
										const readFromCache = async () => {
											const readableStream = stream.Readable.toWeb((await fs.open(cacheFile)).createReadStream());
											return deserialize ? (await deserialize(readableStream)) : defaultDeserializer(readableStream) as Awaited<ReturnType<typeof fn>>;
										}
										try {
											return await readFromCache();
										}catch(e: any) {
											if (e.code === "ENOENT") {
												const processAndWrite = async () => {
													const result = await fn();

													const serializeToWriteable = serialize ?? defaultSerializer;
													// atomic write => write to a tempfile, then atomically rename
													const tempFile = `${cacheFile}-${crypto.randomBytes(Math.ceil(5)).toString("hex")}`;
													await serializeToWriteable(result, stream.Writable.toWeb((await fs.open(tempFile, "ax")).createWriteStream()));
													await fs.rename(tempFile, cacheFile);
													return result;
												}
												if(isMainThread) {
													return processAndWrite();
												}else {
													bc.postMessage({type: "start", cacheKey});
													const {type} = await firstValueFrom($bc.pipe(
														filter((message) => message.cacheKey === cacheKey),
														filter(({type}) => type === "startack" || type === "inprogress"),
													));
													switch (type) {
														case "startack": {
															try {
																const result = await (async () => {
																	try {
																		return await readFromCache();
																	}catch(e: any) {
																		if (e.code === "ENOENT") {
																			return processAndWrite();
																		}else {
																			throw e;
																		}
																	}
																})();
																bc.postMessage({type: "finish", cacheKey});
																return result;
															}catch(e) {
																bc.postMessage({type: "finish_error", cacheKey});
																throw e;
															}
														}
														case "inprogress": {
															await firstValueFrom($bc.pipe(
																filter((message) => message.cacheKey === cacheKey),
																filter(({type}) => type === "finished"),
															));
															return readFromCache();
														}
														default: throw new Error("not supported type: " + type);
													}
												}
											}else {
												throw e;
											}
										}
									})();
									memoryCache.set(cacheKey, result);
									return result;
								}finally {
									delete inProgress[cacheKey];
								}
							})();
						}else {
							return inProgress[cacheKey].then(async (res: any) => {
								if (res === FORCE_REFETCH) {
									const cacheFile = path.join(await cacheDir, cacheKey);
									const memoryCachedValue = memoryCache.get(cacheKey);
									if (memoryCachedValue !== undefined) {
										return memoryCachedValue as Promise<Awaited<ReturnType<typeof fn>>>;
									}
									const readableStream = stream.Readable.toWeb((await fs.open(cacheFile)).createReadStream());
									const result = deserialize ? (await deserialize(readableStream)) : defaultDeserializer(readableStream) as Awaited<ReturnType<typeof fn>>;
									memoryCache.set(cacheKey, result);
									return result;
								}else {
									return res;
								}
							});
						}
					}
				}
				if (isMainThread) {
					$bc.pipe(
						filter(({type}) => type === "start"),
					).subscribe(({cacheKey}) => {
						if (inProgress[cacheKey] === undefined) {
							inProgress[cacheKey] = (async () => {
								bc.postMessage({type: "startack", cacheKey})
								const {type} = await firstValueFrom($bc.pipe(
									filter((message) => message.cacheKey === cacheKey),
									filter(({type}) => type === "finish" || type === "finish_error"),
								));
								delete inProgress[cacheKey];
								if (type === "finish") {
									return FORCE_REFETCH;
								}else {
									throw new Error("Processing failed");
								}
							})();
							// in case there is no handler in the main thread
							// as that would result in an uncaught rejection
							inProgress[cacheKey].catch(() => {});
						}else {
							bc.postMessage({type: "inprogress", cacheKey});
							// finally results in an uncaught rejection
							// so catch().then() is better here
							inProgress[cacheKey].catch(() => {}).then(() => {
								bc.postMessage({type: "finished", cacheKey});
							});
						}
					});
				}
				coordinators[effectiveBroadcastChannelName] = coordinator;
				return coordinator;
			}else {
				return coordinators[effectiveBroadcastChannelName];
			}
		})();
		const calculatedBaseKey = baseKey?.() ?? "";

		return <F extends (...args: any[]) => any>(fn: F, {calcCacheKey, serialize, deserialize}: Options<F>): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> => {
			return async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> => {
				const cacheKey = await (async () => {
					const calculatedCacheKey = await calcCacheKey(...args);
					if (Array.isArray(calculatedCacheKey)) {
						return await fastHash((await Promise.all(calculatedCacheKey.map(async (v) => {
							const vRes = await v;
							if (typeof vRes === "function") {
								const vResRes = await vRes();
								return await fastHash(typeof(vResRes)) + await fastHash(String(vResRes));
							}else if (Buffer.isBuffer(vRes)) {
								return await fastHash("Buffer") + await fastHash(vRes);
							}else {
								return await fastHash(typeof(vRes)) + await fastHash(String(vRes));
							}
						}))).join("") + await fastHash(await calculatedBaseKey));
					}else if (calculatedCacheKey === undefined) {
						throw new Error("CalculatedCacheKey is undefined");
					}else if (typeof calculatedCacheKey === "function") {
						const vRes = await calculatedCacheKey();
						if (Buffer.isBuffer(vRes)) {
							return await fastHash(await fastHash(vRes) + await fastHash(await calculatedBaseKey));
						}else {
							return await fastHash(await fastHash(String(vRes)) + await fastHash(await calculatedBaseKey));
						}
					}else {
						if (Buffer.isBuffer(calculatedCacheKey)) {
							return await fastHash(await fastHash(calculatedCacheKey) + await fastHash(await calculatedBaseKey));
						}else {
							return await fastHash(await fastHash(String(calculatedCacheKey)) + await fastHash(await calculatedBaseKey));
						}
					}
				})();
				return coordinator.task(cacheKey, serialize, deserialize, () => fn(...args));
			};
		};
	}
})();
