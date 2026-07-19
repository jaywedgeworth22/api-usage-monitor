import { ImageResponse } from "next/og";

// Usage Monitor app icon.
//
// Colors: orange-500 -> amber-600 (#f97316 -> #d97706), the same Tailwind
// tokens already used throughout the app as its accent color (see e.g.
// src/components/ProviderCard.tsx connector chips and the cost-coverage
// caveat callouts in src/app/providers/[id]/cost-coverage-caveat.tsx and
// src/components/DashboardProviderWorkspace.tsx). The nav logo itself is
// currently a blue/indigo gradient, but there is no dedicated CSS brand
// variable in globals.css/tailwind.config.ts, so this reuses the orange
// tone that already recurs as the app's accent color elsewhere.
//
// Glyph: the same ascending 3-bar usage/monitoring mark already drawn in
// src/components/Nav.tsx's logo badge, so the favicon and the in-app mark
// read as one continuous brand rather than a newly invented shape.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #f97316 0%, #d97706 100%)",
          borderRadius: 7,
        }}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ffffff"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
