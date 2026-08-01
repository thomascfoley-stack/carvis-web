/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Lint findings shouldn't block a deploy of a voice toy.
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Web Speech API + mic require a secure context; Vercel gives us HTTPS.
          { key: "Permissions-Policy", value: "microphone=(self)" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
