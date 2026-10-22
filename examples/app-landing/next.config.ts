import type { NextConfig } from "next";

const config: NextConfig = {
	output: "export",
	// Set when hosted under a sub-path (the PageLens GitHub Pages deploy); unset in development.
	basePath: process.env.BASE_PATH || undefined,
	images: { unoptimized: true },
	trailingSlash: true,
	reactStrictMode: true,
	compiler: {
		removeConsole: { exclude: ["error"] },
	},
};

export default config;
