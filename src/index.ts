import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import XXHash from "xxhash-addon";
import findCacheDir from "find-cache-dir";
import {AsyncOrSync} from "ts-essentials";

export const fastHash = (x: Parameters<crypto.Hash["update"]>[0]) => XXHash.XXHash3.hash(Buffer.from(x)).toString("hex");

export const withFileCache = (baseKey?: () => AsyncOrSync<string>) => {
	const calculatedBaseKey = baseKey?.() ?? "";

	const cacheDir = (async () => {
		const cacheDir = findCacheDir({name: "book-platform"})!;

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

	type CacheKeyElement = string | number;

	return <F extends (...args: any[]) => any>(fn: F, {calcCacheKey, serialize, deserialize}: {calcCacheKey: (...params: Parameters<F>) => AsyncOrSync<Array<AsyncOrSync<CacheKeyElement>> | CacheKeyElement>, serialize?: (result: Awaited<ReturnType<F>>) => Buffer | string | Promise<Buffer | string>, deserialize?: (str: Buffer) => Promise<Awaited<ReturnType<F>>> | Awaited<ReturnType<F>>}): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> => {
		const inProgress = {} as {[i: string]: Promise<ReturnType<F>> | undefined};
		return async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> => {
			const cacheKey = await (async () => {
				const calculatedCacheKey = await calcCacheKey(...args);
				if (Array.isArray(calculatedCacheKey)) {
					return fastHash((await Promise.all(calculatedCacheKey.map(async (v) => {
						const vRes = await v;
						return fastHash(typeof(vRes)) + fastHash(String(vRes));
					}))).join("") + fastHash(await calculatedBaseKey));
				}else if (calculatedCacheKey === undefined) {
					throw new Error("CalculatedCacheKey is undefined");
				}else {
					return fastHash(fastHash(String(calculatedCacheKey)) + fastHash(await calculatedBaseKey));
				}
			})();
			const memoryCachedValue = memoryCache.get(cacheKey);
			if (memoryCachedValue !== undefined) {
				return memoryCachedValue as Promise<Awaited<ReturnType<F>>>;
			}
			if (inProgress[cacheKey]) {
				return inProgress[cacheKey] as Promise<Awaited<ReturnType<F>>>;
			}else {
				// everything from this point should run synchronously
				// otherwise there is a race condition and the fn will be called multiple times
				const resultProm = (async () => {
					const cacheFile = path.join(await cacheDir, cacheKey);
					const result = await (async () => {
						try {
							const serialized = await fs.readFile(cacheFile);
							const result = deserialize ? (await deserialize(serialized)) : JSON.parse(serialized.toString("utf8")).val as Awaited<ReturnType<F>>;

							return result;
						}catch(e: any) {
							if (e.code === "ENOENT") {
								const result = await fn(...args);

								const serialized = serialize ? (await serialize(result)) : JSON.stringify({val: result});
								// atomic write => write to a tempfile, then atomically rename
								const tempFile = `${cacheFile}-${crypto.randomBytes(Math.ceil(5)).toString("hex")}`;
								await fs.writeFile(tempFile, serialized);
								await fs.rename(tempFile, cacheFile);
								return result;
							}else {
								throw e;
							}
						}
					})();
					memoryCache.set(cacheKey, result);
					inProgress[cacheKey] = undefined;
					return result;
				})();
				inProgress[cacheKey] = resultProm;
				return resultProm as Promise<Awaited<ReturnType<F>>>;
			}
		};
	};
};
