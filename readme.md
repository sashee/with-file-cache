# Filesystem-based cache to add to functions

Make a function cached to the filesystem and persist results even between restarts. Supports waiting for in-progress results and works across workers.

## Installation

```
npm install with-file-cache
```

## Usage

```
import {withFileCache} from "with-file-cache";

// initialize the cache
const addFileCache = withFileCache({baseKey: () => ""});

const fn = addFileCache(async (name) => {
	console.log("Called fn with " + name);
	return "Hello " + name + "!";
}, {calcCacheKey: (arg) => arg});

await fn("Bob");
// called fn with Bob
await fn("Bob");
await fn("Joe");
// called fn with Joe
```

### Add the package-lock.json to the cache key

Usually, when dependencies change you want to invalidate all caches. To do this, use the ```baseKey``` configuration of the ```withFileCache```:

```
import fs from "node:fs/promises";
import crypto from  "node:crypto";

const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");

export const addFileCache = withFileCache(
	{baseKey: async () => {
		return sha(await fs.readFile("package-lock.json", "utf-8"));
	}},
);
```

### Configure the cache key

Use the ```calcCacheKey``` function to define how the cache key is calculated. When a cache key is already found in the cache then the function won't be called.

Supports simple values, arrays, and functions.

### Serialize/deserialize

Simple JS values and Buffers are automatically serialized to the file, but sometimes the function's result can't be written easily. In that case, use the
```serialize```/```deserialize``` to configure how to convert to and from a Buffer.

```
const getStyle = addFileCache(async (assetsOutDir) => {
	// ...
	return {style: rewritten, assetFiles};
}, {calcCacheKey: async (assetsOutDir) => {
	const files = await glob("**/*.*", {cwd: path.join(__dirname, "_assets", "stylesheets"), stat: true, nodir: true, withFileTypes: true});
	return ["getStyle", assetsOutDir, ...files.map((file) => ({path: file.fullpath(), mtime: file.mtime.getTime()})).sort((a, b) => a.path > b.path ? 1 : -1).map((o) => JSON.stringify(o))];
}, serialize: async ({style, assetFiles}) => {
	const zipBlobWriter = new zip.BlobWriter();
	const zipWriter = new zip.ZipWriter(zipBlobWriter);
	zipWriter.add("__index", new zip.TextReader(JSON.stringify({style, assetFiles: assetFiles.map(({name}) => name)})));
	await assetFiles.reduce(async (memo, {name, getContents}) => {
		await memo;
		await zipWriter.add(name, new zip.Uint8ArrayReader(new Uint8Array(await getContents())))
	}, Promise.resolve());

	await zipWriter.close();
	return Buffer.from(await (await zipBlobWriter.getData()).arrayBuffer());
}, deserialize: async (file) => {
	const zipReader = new zip.ZipReader(new zip.Uint8ArrayReader(new Uint8Array(file)));
	const entries = await zipReader.getEntries();
	const {style, assetFiles} = JSON.parse(await (entries.find(({filename}) => filename === "__index").getData(new zip.TextWriter())));

	return {
		style,
		assetFiles: assetFiles.map((name) => {
			return {
				name,
				getContents: async () => {
					return Buffer.from(await (await entries.find(({filename}) => filename === name).getData(new zip.BlobWriter())).arrayBuffer())
				}
			}
		})
	}
}});
```
