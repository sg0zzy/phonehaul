#!/usr/bin/env node
import { startReceiver } from './app.js';

async function main() {
  let receiver;
  try {
    const transferPort = Number(process.env.PHONEHAUL_TRANSFER_PORT ?? 57322);
    if (!Number.isInteger(transferPort) || transferPort < 0 || transferPort > 65535)
      throw Error('PHONEHAUL_TRANSFER_PORT must be a port from 0 to 65535');
    receiver = await startReceiver({
      openBrowser: process.env.PHONEHAUL_NO_BROWSER !== '1',
      transferPort,
      settingsFile: process.env.PHONEHAUL_SETTINGS_FILE,
      exitOnUiClose: process.env.PHONEHAUL_EXIT_ON_UI_CLOSE === '1',
    });
    if (process.env.PHONEHAUL_DESKTOP_MANAGED === '1') {
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        try {
          await receiver.close();
        } catch (error) {
          console.error(error.message);
          process.exitCode = 1;
        }
      };
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
      console.log(
        `PHONEHAUL_READY ${JSON.stringify({ uiUrl: receiver.uiUrl, host: receiver.host, port: receiver.port })}`,
      );
      return;
    }
    console.log('\nPhoneHaul Receiver\n');
    console.log('Receiver ready.');
    console.log('LAN transfers: enabled');
    if (process.env.PHONEHAUL_EXIT_ON_UI_CLOSE === '1')
      console.log('Shutdown: 15 seconds after browser heartbeat stops');
    console.log(`Destination: ${receiver.settings.destination}`);
    console.log(`\nOpening browser:\n${receiver.uiUrl}\n`);
    console.log('Press Ctrl+C to stop.');
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      console.log('\nStopping PhoneHaul Receiver…');
      try {
        await receiver.close();
      } catch (error) {
        console.error(`Shutdown failed: ${error.message}`);
        process.exitCode = 1;
      }
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
