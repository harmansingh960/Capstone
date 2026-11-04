import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isTrustedOrigin } from "@/lib/origin";

/**
 * Next.js 16 Proxy convention (formerly middleware).
 * Enforces CORS controls, origin validation, and preflight handling on API routes.
 */
export function proxy(request: NextRequest) {
  const origin = request.headers.get("origin");

  // Non-browser or same-origin requests without an Origin header proceed normally
  if (!origin) {
    return NextResponse.next();
  }

  const isOriginAllowed = isTrustedOrigin(origin, request.nextUrl.origin);

  // Handle CORS preflight (OPTIONS) requests
  if (request.method === "OPTIONS") {
    if (!isOriginAllowed) {
      return NextResponse.json(
        {
          error: "Forbidden",
          message: "Cross-origin request from untrusted origin blocked.",
        },
        { status: 403 },
      );
    }

    return new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, x-orchestr-cron-secret",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Block unauthorized cross-origin mutations (CSRF protection for state-changing endpoints)
  const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(
    request.method.toUpperCase(),
  );

  if (!isOriginAllowed && isMutation) {
    return NextResponse.json(
      {
        error: "Forbidden",
        message: "Cross-origin requests from untrusted origins are blocked.",
      },
      { status: 403 },
    );
  }

  const response = NextResponse.next();

  // Attach explicit origin CORS headers only for verified trusted origins (never wildcard '*')
  if (isOriginAllowed) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }

  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};

