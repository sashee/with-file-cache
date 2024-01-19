import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import XXHash from "xxhash-addon";
import findCacheDir from "find-cache-dir";
import {AsyncOrSync} from "ts-essentials";
import {isMainThread, BroadcastChannel, threadId} from "node:worker_threads";
import { strict as assert } from "node:assert";
import {ValueOf} from "ts-essentials";
import {Observable, firstValueFrom} from "rxjs";
import {share, filter, first, tap} from "rxjs/operators";
import util from "node:util";
import {debug} from "debug-next";

const log = debug("with-file-cache");

export const fastHash = (x: Parameters<crypto.Hash["update"]>[0]) => XXHash.XXHash3.hash(Buffer.from(x)).toString("hex");

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
		task(cacheKey: string, serialize: any, deserialize: any, fn: any): Promise<any>,
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
						log("data", message.data, "mainThread", isMainThread, "threadId", threadId);
						subscriber.next(message.data);
					};
					(bc as any as EventTarget).addEventListener("message", handler);
					return () => {
						(bc as any as EventTarget).removeEventListener("message", handler);
					}
				}).pipe(share());
				const coordinator: Coordinator = {
					task: (cacheKey, serialize, deserialize, fn) => {
						log("task for: ", cacheKey, " inprogress", inProgress, "mainThread", isMainThread, "threadId", threadId);
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
											const serialized = await fs.readFile(cacheFile);
											return deserialize ? (await deserialize(serialized)) : JSON.parse(serialized.toString("utf8")).val as Awaited<ReturnType<typeof fn>>;
										}
										try {
											return await readFromCache();
										}catch(e: any) {
											if (e.code === "ENOENT") {
												const processAndWrite = async () => {
													const result = await fn();

													const serialized = serialize ? (await serialize(result)) : JSON.stringify({val: result});
													// atomic write => write to a tempfile, then atomically rename
													const tempFile = `${cacheFile}-${crypto.randomBytes(Math.ceil(5)).toString("hex")}`;
													await fs.writeFile(tempFile, serialized);
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
									const serialized = await fs.readFile(cacheFile);
									const result = deserialize ? (await deserialize(serialized)) : JSON.parse(serialized.toString("utf8")).val as Awaited<ReturnType<typeof fn>>;
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
							log("in progress: ", inProgress, "cacheKey", cacheKey, "mainThread", isMainThread, "threadId", threadId);
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

		type CacheKeyElement = string | number | (() => AsyncOrSync<string | number>);
		return <F extends (...args: any[]) => any>(fn: F, {calcCacheKey, serialize, deserialize}: {calcCacheKey: (...params: Parameters<F>) => AsyncOrSync<Array<AsyncOrSync<CacheKeyElement>> | CacheKeyElement>, serialize?: (result: Awaited<ReturnType<F>>) => Buffer | string | Promise<Buffer | string>, deserialize?: (str: Buffer) => Promise<Awaited<ReturnType<F>>> | Awaited<ReturnType<F>>}): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> => {
			return async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> => {
				const cacheKey = await (async () => {
					const calculatedCacheKey = await calcCacheKey(...args);
					log(calculatedCacheKey)
					if (Array.isArray(calculatedCacheKey)) {
						return fastHash((await Promise.all(calculatedCacheKey.map(async (v) => {
							const vRes = await v;
							if (typeof vRes === "function") {
								const vResRes = await vRes();
								return fastHash(typeof(vResRes)) + fastHash(String(vResRes));
							}else {
								return fastHash(typeof(vRes)) + fastHash(String(vRes));
							}
						}))).join("") + fastHash(await calculatedBaseKey));
					}else if (calculatedCacheKey === undefined) {
						throw new Error("CalculatedCacheKey is undefined");
					}else if (typeof calculatedCacheKey === "function") {
						const vRes = await calculatedCacheKey();
						log("vRes", vRes)
						return fastHash(fastHash(String(vRes)) + fastHash(await calculatedBaseKey));
					}else {
						return fastHash(fastHash(String(calculatedCacheKey)) + fastHash(await calculatedBaseKey));
					}
				})();
				return coordinator.task(cacheKey, serialize, deserialize, () => fn(...args));
			};
		};
	}
})();
