import { redirect } from "next/navigation";

import { SignInView } from "@/modules/auth/ui/views/sign-in-view";
import { caller } from "@/trpc/server";

export const dynamic = "force-dynamic";

const SignInPage = async () => {
  const session = await caller.auth.session();

  if (session.user) redirect("/");

  return <SignInView />;
};
export default SignInPage;
