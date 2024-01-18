import {describe, it, mock} from "node:test";
import { strict as assert } from "node:assert";
import {withFileCache} from "../index.js";
import crypto from "node:crypto";
import {Worker} from "node:worker_threads";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

describe.only("basic", () => {
	it("allows returning undefined, null, and empty string", async () => {
		const testId = crypto.randomUUID();
		const cachedFunction = withFileCache({baseKey: () => testId, broadcastChannelName: testId})((arg: string | undefined | null) => {
			return arg;
		}, {calcCacheKey: (arg) => [typeof arg, String(arg)]});
		await cachedFunction(null);
		assert.equal(await cachedFunction(null), null);
		await cachedFunction(undefined);
		assert.equal(await cachedFunction(undefined), undefined);
		await cachedFunction("");
		assert.equal(await cachedFunction(""), "");
	});
	it("calls the function for different cache keys", async () => {
		const testId = crypto.randomUUID();
		const fn = mock.fn((arg: string) => {
			return arg;
		});
		const cachedFunction = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg});
		const res1 = await cachedFunction("a");
		assert.equal(res1, "a");
		assert.equal(fn.mock.calls.length, 1);
		const res2 = await cachedFunction("b");
		assert.equal(res2, "b");
		assert.equal(fn.mock.calls.length, 2);
	});
	it("does not call the function when a cache key was already calculated", async () => {
		const testId = crypto.randomUUID();
		const fn = mock.fn((arg: string) => {
			return arg;
		});
		const cachedFunction = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg});
		const res1 = await cachedFunction("a");
		assert.equal(res1, "a");
		assert.equal(fn.mock.calls.length, 1);
		const res2 = await cachedFunction("a");
		assert.equal(res2, "a");
		assert.equal(fn.mock.calls.length, 1);
	});
	describe.only("baseKey", () => {
		it("different baseKeys result in different cache keys", async () => {
			const testId = crypto.randomUUID();
			const fn = mock.fn((arg: string) => {
			});
			await withFileCache({baseKey: () => testId + "1", broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
			assert.equal(fn.mock.calls.length, 1);
			await withFileCache({baseKey: () => testId + "2", broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
	 		assert.equal(fn.mock.calls.length, 2);
		});
		it("same baseKeys result in the same cache keys", async () => {
			const testId = crypto.randomUUID();
			const fn = mock.fn((arg: string) => {
				return arg;
			});
			const res1 = await withFileCache({baseKey: () => testId + "1", broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
			assert.equal(fn.mock.calls.length, 1);
			assert.equal(res1, "a");
			const res2 = await withFileCache({baseKey: () => testId + "1", broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
	 		assert.equal(fn.mock.calls.length, 1);
			assert.equal(res2, "a");
		});
	})
});
describe.only("in-process concurrency", () => {
	it("calls the function once if the same key is calculated concurrently", async () => {
		const testId = crypto.randomUUID();
		let calledResolve: (v: unknown) => void;
		const calledPromise = new Promise((res) => calledResolve = res);
		let resolve: (v: unknown) => void;
		const promise = new Promise((res) => resolve = res);

		const fn = mock.fn((arg: string) => {
			calledResolve!(undefined);
			return promise;
		});
		const cachedFunction = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg});
		const res1Prom = cachedFunction("a");
		const res2Prom = cachedFunction("a");
		await calledPromise;
		assert.equal(fn.mock.calls.length, 1);
		resolve!("value");
		assert.equal(await res1Prom, "value");
		assert.equal(await res2Prom, "value");
		assert.equal(fn.mock.calls.length, 1);
	});
	it("calls the function once if the same key is calculated concurrently even for different instances", async () => {
		const testId = crypto.randomUUID();
		let calledResolve: (v: unknown) => void;
		const calledPromise = new Promise((res) => calledResolve = res);
		let resolve: (v: unknown) => void;
		const promise = new Promise((res) => resolve = res);

		const fn = mock.fn((arg: string) => {
			calledResolve!(undefined);
			return promise;
		});
		const res1Prom = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
		const res2Prom = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
		await calledPromise;
		assert.equal(fn.mock.calls.length, 1);
		resolve!("value");
		assert.equal(await res1Prom, "value");
		assert.equal(await res2Prom, "value");
		assert.equal(fn.mock.calls.length, 1);
	});
});

describe.only("inter-worker concurrency", () => {
	it.only("calls the function once if the same key is calculated concurrently", async () => {
		const testId = crypto.randomUUID();
		let calledResolve: (v: unknown) => void;
		const calledPromise = new Promise((res) => calledResolve = res);
		let resolve: (v: unknown) => void;
		const promise = new Promise((res) => resolve = res);

		const fn = mock.fn((arg: string) => {
			calledResolve!(undefined);
			return promise;
		});
		const res1Prom = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
		const worker = new Worker(path.join(__dirname, "worker.ts"), {workerData: {testId}});

		await calledPromise;
		assert.equal(fn.mock.calls.length, 1);
		worker.on("message", async ({type}) => {
			if (type === "started") {
				resolve!("value");
			}
		})
		await res1Prom;
		assert.equal(await res1Prom, "value");
		const {calls, res} = await new Promise<{calls: number, res: string}>((resolve) => {
			worker.on("message", async ({type, calls, res}) => {
				if (type === "calls") {
					await worker.terminate();
					return resolve({calls, res});
				}
			})
			worker.postMessage("check");
		});
		assert.equal(calls, 0);
		assert.equal(res, "value");
	});
	// TODO: works if the worker is calculating and the main thread is waiting
	// TODO: works if another worker is calculating
	// TODO: throws an error in the worker if the main thread is throwing one
	// TODO: throws an error in the main thread if the worker is throwing one
	// TODO: if a worker is calculating then another call inside the same worker won't start another call
	// TODO: if a worker is waiting for the main thread twice then there still won't be any calls
	//
	// TODO: serializer is called when the value is written
	// TODO: deserializer is called when the value is read (different instance only, because of the memory cache)
	// TODO: if the main thread is calculating with different instances then there won't be a call to the deserializer
	// TODO: when a worker finishes calculating then the deserializer is called in the main thread
});
