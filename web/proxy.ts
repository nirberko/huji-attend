import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional HTTP Basic auth for the whole app. The DB holds other people's Moodle tokens,
 * so set APP_PASSWORD before exposing this anywhere public. Any username is accepted.
 */
export function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const [scheme, encoded] = (request.headers.get("authorization") ?? "").split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = atob(encoded);
    if (decoded.slice(decoded.indexOf(":") + 1) === password) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="huji-attend"' },
  });
}
