import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every page/route here is dynamic, so no incremental cache is needed.
export default defineCloudflareConfig({});
