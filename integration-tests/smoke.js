#!/usr/bin/env node
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { startReceiver } from '../receiver/src/server/app.js';
import { run } from './fake-sender.js';

const root=await mkdtemp(path.join(os.tmpdir(),'phonehaul-smoke-'));
const source=path.join(root,'source');
const destination=path.join(root,'destination');
await mkdir(path.join(source,'nested'),{recursive:true});
await writeFile(path.join(source,'nested','hello.txt'),'PhoneHaul integration test');
await writeFile(path.join(root,'settings.json'),JSON.stringify({destination,conflict:'rename'}));
const receiver=await startReceiver({settingsFile:path.join(root,'settings.json')});
try {
  const uri=receiver.session.uri(receiver.host,receiver.port,receiver.certFingerprint);
  const result=await run(uri,[source]);
  assert.equal(result.completedItems,1);
  assert.equal(await readFile(path.join(destination,'source','nested','hello.txt'),'utf8'),'PhoneHaul integration test');
  assert.equal(await readFile(path.join(source,'nested','hello.txt'),'utf8'),'PhoneHaul integration test');
  console.log('End-to-end fake sender smoke passed');
} finally {await receiver.close();}
