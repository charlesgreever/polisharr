import { serve } from "@hono/node-server";
import { loadEnv } from "./env.ts";
import { probeFfmpegVersion } from "./hardware.ts";
import { createApp } from "./app.ts";

const env = loadEnv();
const ffmpegVersion = await probeFfmpegVersion(env.ffmpeg);
const { app } = createApp({ env, ffmpegVersion });

serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
  console.log(`Polisharr is listening on http://${info.address}:${info.port}`);
});
