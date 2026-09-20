/** Never log verification URLs or provider response bodies. */
export function verificationEmailSender(apiKey: string, from: string) {
  return async ({ user, url }: { user: { email: string }; url: string }): Promise<void> => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [user.email],
        subject: "Verify your email / E-mail-cím megerősítése",
        text:
          "Verify your email to continue / A folytatáshoz erősítse meg e-mail-címét:\n" +
          url +
          "\nThis link expires in one hour. / A hivatkozás egy óráig érvényes.",
      }),
    });
    if (!response.ok) throw new Error("Verification email delivery failed. Please retry.");
  };
}
