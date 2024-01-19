import {describe, it, mock} from "node:test";
import { strict as assert } from "node:assert";
import {withFileCache} from "../index.js";
import crypto from "node:crypto";
import {Worker, BroadcastChannel} from "node:worker_threads";
import path from "node:path";
import url from "node:url";
import {AsyncOrSync, ValueOf} from "ts-essentials";
import {setTimeout} from "node:timers/promises";
import {Observable, firstValueFrom} from "rxjs";
import {share, filter, first, tap} from "rxjs/operators";
import util from "node:util";
import {debug} from "debug-next";

const log = debug("with-file-cache:test");

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const withResolvers = <T> () => {
	let resolve: (val: AsyncOrSync<T>) => void, reject: (reason: any) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {promise, resolve: resolve!, reject: reject!};
}

process.on('unhandledRejection', (error, p) => {
	log("UNHANDLED REJECTION")
	log(util.inspect(error))
	log("unhandled", util.inspect(p))
});

describe("basic", () => {
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
	it("propagates errors thrown in the function", async () => {
		const testId = crypto.randomUUID();
		const {reject, promise} = withResolvers();
		const {promise: calledPromise, resolve: calledResolve} = withResolvers();
		const fn = (arg: string) => {
			calledResolve(undefined);
			return promise;
		}
		const resProm = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
		await calledPromise;
		await Promise.all([
			(async () => reject("error"))(),
			assert.rejects(resProm),
		])
	});
	describe("baseKey", () => {
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
describe("in-process concurrency", () => {
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

const makeWorker = (testId: string) => {
	const worker = new Worker(path.join(__dirname, "worker.ts"), {workerData: {testId}});
	worker.on("error", (e) => {
		log("WORKER ERROR", e)
	});
	worker.on("exit", (e) => {
		log("WORKER EXIT", e)
	});
	return new Promise<Worker>((res) => {
		worker.on("message", async ({type}) => {
			if (type === "started") {
				res(worker);
			}
		});
	});
}

const makeCallWorker = (worker: Worker) => ({type, runnerId, taskId, param}: {type: string, runnerId: string, taskId?: string, param?: any}) => {
	return new Promise((res, rej) => {
		const requestId = crypto.randomUUID();
		worker.postMessage({type, runnerId, taskId, param, requestId});
		const listener = (message: any) => {
			if (message.requestId === requestId) {
				worker.removeListener("message", listener);
				if (message.error) {
					rej(message.error);
				}else {
					res(message.data);
				}
			}
		}
		worker.addListener("message", listener);
	});
}

const allowedTypes = ["start", "finish", "inprogress", "finished", "startack", "finish_error"] as const;
const bcObservableFactory = (testId: string) => new Observable<{type: ValueOf<typeof allowedTypes>, cacheKey: string}>((subscriber) => {
	const bc = new BroadcastChannel(testId);
	bc.unref();
	const handler = (message: any) => {
		assert(allowedTypes.includes(message.data.type), `message.data.type is outside the allowed values: ${message.data.type}`);
		assert(typeof message.data.cacheKey === "string", `message.data.cacheKey is not string: ${message.data.cacheKey}`);
		subscriber.next(message.data);
	};
	(bc as any as EventTarget).addEventListener("message", handler);
	return () => {
		(bc as any as EventTarget).removeEventListener("message", handler);
	}
}).pipe(share());

describe("inter-worker concurrency", () => {
	it("calls the function once if the same key is calculated concurrently", async () => {
		const testId = crypto.randomUUID();
		const {resolve: calledResolve, promise: calledProm} = withResolvers();
		const {resolve, promise: prom} = withResolvers();

		const fn = mock.fn((arg: string) => {
			calledResolve!(undefined);
			return prom;
		});
		const res1Prom = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
		const worker = await makeWorker(testId);
		try {
			const callWorker = makeCallWorker(worker);

			await calledProm;
			assert.equal(fn.mock.calls.length, 1);

			await Promise.all([
				firstValueFrom(bcObservableFactory(testId).pipe(
					filter((message) => message.type === "start"),
				)),
				(async () => {
					await callWorker({type: "initRunner", runnerId: "1"});
					await callWorker({type: "startTask", runnerId: "1", taskId: "1", param: "a"});
				})(),
			])
			resolve!("value");

			await res1Prom;
			assert.equal(await res1Prom, "value");
			const calls = await callWorker({type: "getCallCount", runnerId: "1", taskId: "1"});
			const res = await callWorker({type: "getResult", runnerId: "1", taskId: "1"});
			assert.equal(calls, 0);
			assert.equal(res, "value");
		}finally {
			await worker.terminate();
		}
	});
	it("works if the worker is calculating and the main thread is waiting", async () => {
		const testId = crypto.randomUUID();

		const worker = await makeWorker(testId);
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId});
		try {
			const callWorker = makeCallWorker(worker);

			await Promise.all([
				firstValueFrom(bcObservableFactory(testId).pipe(
					filter((message) => message.type === "startack"),
				)),
				(async () => {
					await callWorker({type: "initRunner", runnerId: "1"});
					await callWorker({type: "startTask", runnerId: "1", taskId: "1", param: "a"});
				})(),
			])

			const {resolve, promise: prom} = withResolvers();
			const fn = mock.fn((arg: string) => {
				return prom;
			});
			const res1Prom = runner(fn, {calcCacheKey: (arg) => arg})("a");
			assert.equal(fn.mock.calls.length, 0);
			await callWorker({type: "resolve", runnerId: "1", taskId: "1", param: "a"});
			assert.equal(fn.mock.calls.length, 0);
			assert.equal(await res1Prom, "a");
			const calls = await callWorker({type: "getCallCount", runnerId: "1", taskId: "1"});
			const res = await callWorker({type: "getResult", runnerId: "1", taskId: "1"});
			assert.equal(calls, 1);
			assert.equal(res, "a");
		}finally {
			await worker.terminate();
		}
	});
	it("works if another worker is calculating", async () => {
		const testId = crypto.randomUUID();

		const worker1 = await makeWorker(testId);
		const worker2 = await makeWorker(testId);
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId});
		try {
			const callWorker1 = makeCallWorker(worker1);
			const callWorker2 = makeCallWorker(worker2);

			await callWorker1({type: "initRunner", runnerId: "1"});
			await callWorker1({type: "startTask", runnerId: "1", taskId: "1", param: "a"});
			await callWorker1({type: "waitForCalled", runnerId: "1", taskId: "1"});

			await callWorker2({type: "initRunner", runnerId: "1"});
			await callWorker2({type: "startTask", runnerId: "1", taskId: "1", param: "a"});

			await callWorker1({type: "resolve", runnerId: "1", taskId: "1", param: "a"});
			const calls1 = await callWorker1({type: "getCallCount", runnerId: "1", taskId: "1"});
			const res1 = await callWorker1({type: "getResult", runnerId: "1", taskId: "1"});
			const calls2 = await callWorker2({type: "getCallCount", runnerId: "1", taskId: "1"});
			const res2 = await callWorker2({type: "getResult", runnerId: "1", taskId: "1"});
			assert.equal(calls1, 1);
			assert.equal(calls2, 0);
			assert.equal(res1, "a");
			assert.equal(res2, "a");
		}finally {
			await worker1.terminate();
			await worker2.terminate();
		}
	});

	it("throws an error in the worker if the main thread is throwing one", async () => {
		const testId = crypto.randomUUID();
		const {resolve: calledResolve, promise: calledProm} = withResolvers();
		const {reject, promise: prom} = withResolvers();

		const fn = ((arg: string) => {
			calledResolve!(undefined);
			return prom;
		});
		const res1Prom = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
		const worker = await makeWorker(testId);
		try {
			const callWorker = makeCallWorker(worker);

			await calledProm;

			await Promise.all([
				firstValueFrom(bcObservableFactory(testId).pipe(
					filter((message) => message.type === "inprogress"),
				)),
				(async () => {
					await callWorker({type: "initRunner", runnerId: "1"});
					await callWorker({type: "startTask", runnerId: "1", taskId: "1", param: "a"});
				})(),
			]);
			await Promise.all([
				(async () => reject!("abc"))(),
				assert.rejects(res1Prom)
			])
			const calls = await callWorker({type: "getCallCount", runnerId: "1", taskId: "1"});
			assert.equal(calls, 0);
			await assert.rejects(callWorker({type: "getResult", runnerId: "1", taskId: "1"}));
		}finally {
			await worker.terminate();
		}
	});
	it("throws an error in the main thread if the worker is throwing one", async () => {
		const testId = crypto.randomUUID();

		const fn = ((arg: string) => {
		});
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg});
		const worker = await makeWorker(testId);
		try {
			const callWorker = makeCallWorker(worker);

			await callWorker({type: "initRunner", runnerId: "1"});
			await callWorker({type: "startTask", runnerId: "1", taskId: "1", param: "a"});
			await callWorker({type: "waitForCalled", runnerId: "1", taskId: "1"});

			const res1Prom = runner("a");
			await Promise.all([
				callWorker({type: "reject", runnerId: "1", taskId: "1", param: "abc"}),
				assert.rejects(res1Prom),
			])
			const calls = await callWorker({type: "getCallCount", runnerId: "1", taskId: "1"});
			assert.equal(calls, 1);
			await assert.rejects(callWorker({type: "getResult", runnerId: "1", taskId: "1"}));
		}finally {
			await worker.terminate();
		}
	});
	it("if a worker is calculating then another call inside the same worker won't start another call", async () => {
		const testId = crypto.randomUUID();

		const fn = ((arg: string) => {
		});
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg});
		const worker = await makeWorker(testId);
		try {
			const callWorker = makeCallWorker(worker);

			await callWorker({type: "initRunner", runnerId: "1"});
			await callWorker({type: "initRunner", runnerId: "2"});
			await callWorker({type: "startTask", runnerId: "1", taskId: "1", param: "a"});
			await callWorker({type: "waitForCalled", runnerId: "1", taskId: "1"});
			await callWorker({type: "startTask", runnerId: "2", taskId: "1", param: "a"});

			await callWorker({type: "resolve", runnerId: "1", taskId: "1", param: "abc"});
			const calls1 = await callWorker({type: "getCallCount", runnerId: "1", taskId: "1"});
			assert.equal(calls1, 1);
			const calls2 = await callWorker({type: "getCallCount", runnerId: "2", taskId: "1"});
			assert.equal(calls2, 0);
		}finally {
			await worker.terminate();
		}
	});
	it("if a worker is calculating twice and there is an error then both are rejected", async () => {
		const testId = crypto.randomUUID();

		const fn = ((arg: string) => {
		});
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg});
		const worker = await makeWorker(testId);
		try {
			const callWorker = makeCallWorker(worker);

			await callWorker({type: "initRunner", runnerId: "1"});
			await callWorker({type: "initRunner", runnerId: "2"});
			await callWorker({type: "startTask", runnerId: "1", taskId: "1", param: "a"});
			await callWorker({type: "waitForCalled", runnerId: "1", taskId: "1"});
			await callWorker({type: "startTask", runnerId: "2", taskId: "1", param: "a"});

			await callWorker({type: "reject", runnerId: "1", taskId: "1", param: "abc"});
			await assert.rejects(callWorker({type: "getResult", runnerId: "1", taskId: "1"}));
			await assert.rejects(callWorker({type: "getResult", runnerId: "2", taskId: "1"}));
		}finally {
			await worker.terminate();
		}
	});
	it("if a worker is waiting for the main thread twice then there still won't be any calls", async () => {
		const testId = crypto.randomUUID();

		const {resolve: calledResolve, promise: calledProm} = withResolvers();
		const {resolve, promise: prom} = withResolvers();

		const fn = ((arg: string) => {
			calledResolve!(undefined);
			return prom;
		});
		const res1Prom = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg})("a");
		const worker = await makeWorker(testId);
		try {
			const callWorker = makeCallWorker(worker);

			await calledProm;

			await Promise.all([
				firstValueFrom(bcObservableFactory(testId).pipe(
					filter((message) => message.type === "inprogress"),
				)),
				(async () => {
					await callWorker({type: "initRunner", runnerId: "1"});
					await callWorker({type: "startTask", runnerId: "1", taskId: "1", param: "a"});
				})(),
			]);
			await callWorker({type: "initRunner", runnerId: "2"});
			await callWorker({type: "startTask", runnerId: "2", taskId: "1", param: "a"});

			resolve("result");

			const calls1 = await callWorker({type: "getCallCount", runnerId: "1", taskId: "1"});
			assert.equal(calls1, 0);
			const calls2 = await callWorker({type: "getCallCount", runnerId: "2", taskId: "1"});
			assert.equal(calls2, 0);
			const res1 = await callWorker({type: "getResult", runnerId: "1", taskId: "1"});
			assert.equal(res1, "result");
			const res2 = await callWorker({type: "getResult", runnerId: "2", taskId: "1"});
			assert.equal(res2, "result");
		}finally {
			await worker.terminate();
		}
	});
});

describe("serialize/deserialize", () => {
	it("calls the serializer when a value is written to the disk", async () => {
		const testId = crypto.randomUUID();
		const serializer = mock.fn((value) => {
			return value;
		});
		await withFileCache({baseKey: () => testId, broadcastChannelName: testId})((arg) => arg, {calcCacheKey: (arg) => arg, serialize: serializer})("a");
		assert.equal(serializer.mock.calls.length, 1);
		assert.equal(serializer.mock.calls[0].arguments[0], "a");
	});
	it("does not call the serializer when a value is already read from the disk", async () => {
		const testId = crypto.randomUUID();
		const serializer = mock.fn((value) => {
			return value;
		});
		withFileCache({baseKey: () => testId, broadcastChannelName: testId})((arg) => arg, {calcCacheKey: (arg) => arg})("a");
		withFileCache({baseKey: () => testId, broadcastChannelName: testId})((arg) => arg, {calcCacheKey: (arg) => arg, serialize: serializer})("a");
		assert.equal(serializer.mock.calls.length, 0);
	});
	it("deserializer is called when the value is read (different instance only, because of the memory cache)", async () => {
		const testId = crypto.randomUUID();
		const deserializer = mock.fn((value) => {
			log(value)
			return value;
		});
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId})((arg) => arg, {calcCacheKey: (arg) => arg, deserialize: deserializer});
		const worker = await makeWorker(testId);
		try {
			const callWorker = makeCallWorker(worker);

			await callWorker({type: "initRunner", runnerId: "1"});
			await callWorker({type: "startTask", runnerId: "1", taskId: "1", param: "a"});
			await callWorker({type: "waitForCalled", runnerId: "1", taskId: "1"});
			await callWorker({type: "resolve", runnerId: "1", taskId: "1", param: "abc"});

			await runner("a");
			assert.equal(deserializer.mock.calls.length, 1);
			assert(deserializer.mock.calls[0].arguments[0].toString("utf8").includes("abc"));
		}finally {
			await worker.terminate();
		}
	});
	it("if the main thread is calculating with different instances then there won't be a call to the deserializer", async () => {
		const testId = crypto.randomUUID();
		const deserializer = mock.fn((value) => {
			log(value)
			return value;
		});
		await withFileCache({baseKey: () => testId, broadcastChannelName: testId})((arg) => arg, {calcCacheKey: (arg) => arg})("a");
		await withFileCache({baseKey: () => testId, broadcastChannelName: testId})((arg) => arg, {calcCacheKey: (arg) => arg, deserialize: deserializer})("a");
		assert.equal(deserializer.mock.calls.length, 0);
	});
	it("when a worker finishes calculating then the deserializer is called in the main thread", async () => {
		const testId = crypto.randomUUID();
		const deserializer = mock.fn((value) => {
			log(value)
			return "deserialized";
		});
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId})((arg) => arg, {calcCacheKey: (arg) => arg, deserialize: deserializer});
		const worker = await makeWorker(testId);
		try {
			const callWorker = makeCallWorker(worker);

			await callWorker({type: "initRunner", runnerId: "1"});
			await callWorker({type: "startTask", runnerId: "1", taskId: "1", param: "a"});
			await callWorker({type: "waitForCalled", runnerId: "1", taskId: "1"});
			const resProm = runner("a");
			await callWorker({type: "resolve", runnerId: "1", taskId: "1", param: "abc"});
			assert(await resProm, "deserialized");

			assert.equal(deserializer.mock.calls.length, 1);
			assert(deserializer.mock.calls[0].arguments[0].toString("utf8").includes("abc"));
		}finally {
			await worker.terminate();
		}
	});
});

describe("calcCacheKey", () => {
	it("works for simple values", async () => {
		const testId = crypto.randomUUID();
		const fn = mock.fn((arg: any) => {
			return arg;
		});
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg});
		await runner("a");
		assert.equal(fn.mock.calls.length, 1);
		await runner("a");
		assert.equal(fn.mock.calls.length, 1);
		await runner(1);
		assert.equal(fn.mock.calls.length, 2);
		await runner(1);
		assert.equal(fn.mock.calls.length, 2);
		await runner(Promise.resolve(5));
		assert.equal(fn.mock.calls.length, 3);
		await runner(Promise.resolve(5));
		assert.equal(fn.mock.calls.length, 3);
	});
	it("works for arrays", async () => {
		const testId = crypto.randomUUID();
		const fn = mock.fn((arg: any) => {
			return arg;
		});
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => arg});
		await runner(["abc"]);
		assert.equal(fn.mock.calls.length, 1);
		await runner(["abc"]);
		assert.equal(fn.mock.calls.length, 1);
		await runner([1]);
		assert.equal(fn.mock.calls.length, 2);
		await runner([1]);
		assert.equal(fn.mock.calls.length, 2);
		await runner(["abc", 1]);
		assert.equal(fn.mock.calls.length, 3);
		await runner(["abc", 1]);
		assert.equal(fn.mock.calls.length, 3);
		await runner(["abc", 1, Promise.resolve(5)]);
		assert.equal(fn.mock.calls.length, 4);
		await runner(["abc", 1, Promise.resolve(5)]);
		assert.equal(fn.mock.calls.length, 4);
	});
	it("works when it returns a function", async () => {
		const testId = crypto.randomUUID();
		const fn = mock.fn((arg: any) => {
			return arg;
		});
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg) => async () => arg});
		await runner("abc");
		assert.equal(fn.mock.calls.length, 1);
		await runner("abc");
		assert.equal(fn.mock.calls.length, 1);
		await runner(1);
		assert.equal(fn.mock.calls.length, 2);
		await runner(1);
		assert.equal(fn.mock.calls.length, 2);
		await runner(["abc", "1"]);
		assert.equal(fn.mock.calls.length, 3);
	});
	it("works when it returns a function in an array", async () => {
		const testId = crypto.randomUUID();
		const fn = mock.fn((arg: any, arg2: any) => {
			return arg;
		});
		const runner = withFileCache({baseKey: () => testId, broadcastChannelName: testId})(fn, {calcCacheKey: (arg, arg2) => [arg, async () => arg2]});
		await runner("a", "b");
		assert.equal(fn.mock.calls.length, 1);
		await runner("a", "b");
		assert.equal(fn.mock.calls.length, 1);
		await runner("a", "2");
		assert.equal(fn.mock.calls.length, 2);
		await runner("a", "2");
		assert.equal(fn.mock.calls.length, 2);
		await runner("a", 2);
		assert.equal(fn.mock.calls.length, 3);
	});
});

