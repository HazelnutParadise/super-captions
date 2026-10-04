/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    turbopackFileSystemCacheForDev: process.env.NEXT_TURBOPACK_FS_CACHE !== "0",
    turbopackFileSystemCacheForBuild: process.env.NEXT_TURBOPACK_FS_CACHE !== "0",
  },
  // Note: we deliberately do NOT set COOP/COEP. The single-threaded
  // @ffmpeg/core build runs fine without SharedArrayBuffer, and skipping
  // those headers lets third-party scripts (e.g. the OneAD ad embed) load
  // without needing CORP headers from their origin.
};

module.exports = nextConfig;
