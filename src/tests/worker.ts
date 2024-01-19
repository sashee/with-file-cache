import {withFileCache} from "../index.js";
import {workerData, parentPort} from "node:worker_threads";
import {mock} from "node:test";
import {AsyncOrSync} from "ts-essentials";
import {setTimeout} from "node:timers/promises";
import util from "node:util";
import {debug} from "debug-next";

const log = debug("with-file-cache:test:worker");

const withResolvers = <T> () => {
	let resolve: (val: AsyncOrSync<T>) => void, reject: (reason: any) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {promise, resolve: resolve!, reject: reject!};
}

process.on('unhandledRejection', (error, p) => {
	log("UNHANDLED REJECTION IN WORKER")
	log(util.inspect(error))
	log("unhandled", util.inspect(p))
});

const runners = {} as {[runnerId: string]: any};

parentPort?.postMessage({type: "started"});

parentPort!.on("message", async ({type, runnerId, taskId, requestId, param}) => {
	if (type === "initRunner") {
		if (runners[runnerId]) {
			parentPort?.postMessage({type: "response", requestId, error: "Runner with id: " + runnerId + " already exists"});
		}else {
			runners[runnerId] = {
				runner: withFileCache({baseKey: () => workerData.testId, broadcastChannelName: workerData.testId}),
				tasks: {},
			}
			parentPort?.postMessage({type: "response", requestId});
		}
	}else if (type === "startTask") {
		if (runners[runnerId]) {
			if (runners[runnerId][taskId]) {
				parentPort?.postMessage({type: "response", requestId, error: "Task with id: " + taskId + " at runner: " + runnerId + " already exists"});
			}else {
				const {resolve, reject, promise} = withResolvers();
				const {resolve: calledResolve, promise: calledPromise} = withResolvers();
				const fn = mock.fn((arg: string) => {
					calledResolve(undefined);
					return promise;
				});
				const resultProm = runners[runnerId].runner(fn, {calcCacheKey: (arg: string) => arg})(param)
				const result = {status: "pending", data: undefined, error: undefined};
				resultProm.then((res: any) => {
					result.status = "fulfilled";
					result.data = res;
				}, (err: any) => {
					result.status = "fulfilled";
					result.error = err;
				})
				runners[runnerId].tasks[taskId] = {
					resolve, reject, promise, fn, result, calledPromise,
				};
				parentPort?.postMessage({type: "response", requestId});
			}
		}else {
			parentPort?.postMessage({type: "response", requestId, error: "Runner with id: " + runnerId + " does not exist"});
		}
	}else if (type === "resolve") {
		runners[runnerId].tasks[taskId].resolve(param);
		parentPort?.postMessage({type: "response", requestId});
	}else if (type === "reject") {
		runners[runnerId].tasks[taskId].reject(param);
		parentPort?.postMessage({type: "response", requestId});
	}else if (type === "getCallCount") {
		parentPort?.postMessage({type: "response", requestId, data: runners[runnerId].tasks[taskId].fn.mock.callCount()});
	}else if (type === "waitForCalled") {
		log("waitForCalled")
		parentPort?.postMessage({type: "response", requestId, data: await runners[runnerId].tasks[taskId].calledPromise});
	}else if (type === "getResult") {
		if (runners[runnerId].tasks[taskId].result.status === "pending") {
			await setTimeout(100);
			if (runners[runnerId].tasks[taskId].result.status === "pending") {
				parentPort?.postMessage({type: "response", requestId, error: "TIMEOUT"});
			}
		}
		if (runners[runnerId].tasks[taskId].result.error) {
			parentPort?.postMessage({type: "response", requestId, error: "result is an error"});
		}else {
			parentPort?.postMessage({type: "response", requestId, data: runners[runnerId].tasks[taskId].result.data});
		}
	}
});

