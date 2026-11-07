// Discord does not provide a supported public endpoint for unattended username monitoring.
// Keep the result UNKNOWN unless availability is verified through Discord's official UI.
export async function checkUsername() {
  return { status: "UNKNOWN", reason: "No supported public availability check is configured." };
}