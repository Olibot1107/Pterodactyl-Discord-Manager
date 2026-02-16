const { Resend } = require('resend');

// Load Resend API key from settings or environment variables
const { RESEND_API_KEY } = require('../../settings');

if (!RESEND_API_KEY) {
  throw new Error("Missing Resend API key. Set RESEND_API_KEY in settings.js.");
}

const resend = new Resend(RESEND_API_KEY);

// Send verification email
module.exports = async function sendVerificationEmail(email, code) {
  if (!email || !code) {
    throw new Error("Email and verification code are required.");
  }

  try {
    const result = await resend.emails.send({
      from: "Voidium <no-reply@email.voidium.uk>",
      to: email,
      subject: "Voidium Email Verification",
      html: `
        <div style="font-family:sans-serif; padding:20px; background:#f9f9f9; border-radius:8px;">
          <h2 style="color:#333;">Verify Your Email</h2>
          <p>Your one-time verification code is:</p>
          <div style="font-size:22px; font-weight:bold; margin:10px 0; color:#000;">${code}</div>
          <p>This code will expire in <strong>5 minutes</strong>.</p>
          <p style="margin-top:20px; color:#555;">If you didn't request this, you can safely ignore this email.</p>
          <p style="margin-top:30px; font-size:13px; color:#888;">
            ⚠️ <strong>Please do not reply to this email.</strong> This mailbox is not monitored.
          </p>
          <hr style="margin:20px 0; border:none; border-top:1px solid #ddd;" />
          <footer style="font-size:12px; color:#aaa;">
            Voidium • <a href="https://voidium.uk" style="color:#888; text-decoration:none;">https://voidium.uk</a>
          </footer>
        </div>
      `,
    });

    console.log(`✅ Verification email sent to ${email}`);
  } catch (error) {
    console.error(`❌ Failed to send email to ${email}:`, error);
    throw error;
  }
};
