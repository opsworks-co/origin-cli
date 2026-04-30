// Vite-injected at build time via define in vite.config.ts. The constant
// uniquely identifies the JS bundle the client is currently running, so the
// runtime can compare it against /build-info.json and prompt the user to
// reload after a new deploy.
declare const __BUILD_ID__: string;
