import { deleteUser } from "@/lib/db";

export async function DELETE(_request: Request, ctx: RouteContext<"/api/users/[id]">) {
  const { id } = await ctx.params;
  await deleteUser(Number(id));
  return new Response(null, { status: 204 });
}
