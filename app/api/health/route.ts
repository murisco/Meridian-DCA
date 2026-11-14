export async function GET() {
  return Response.json({
    status: "ok",
    app: "meridian-dca",
    mode: "dry-run-only",
    timestamp: new Date().toISOString(),
  });
}