import { listUsers, saveSession, toAccount } from "@/lib/db";
import { errorMessage, isAttendanceQr, markAttendance } from "@/lib/moodle";

/** Mark every connected user present for the class QR that was scanned. */
export async function POST(request: Request) {
  const { payload, status } = (await request.json()) as { payload?: string; status?: string };
  if (!payload || !isAttendanceQr(payload)) {
    return Response.json(
      { error: "Not an attendance QR — expected a mod/attendance link." },
      { status: 400 },
    );
  }
  const users = await listUsers();
  const results = await Promise.all(
    users.map(async (u) => {
      try {
        const label = await markAttendance(toAccount(u), payload, status || undefined, (s) =>
          saveSession(u.id, s),
        );
        return { id: u.id, fullname: u.fullname, ok: true, message: `Marked '${label}'` };
      } catch (e) {
        return { id: u.id, fullname: u.fullname, ok: false, message: errorMessage(e) };
      }
    }),
  );
  return Response.json(results);
}
