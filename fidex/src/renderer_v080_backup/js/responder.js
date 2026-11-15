// PLACEHOLDER RESPONDER.
// This is the single place where chat replies come from. It does NOT use any AI.
// In a later step this function is replaced by the real FIDEX AI brain;
// nothing else in the interface needs to change.

export async function getReply(conversation, userText) {
  const preview = userText.length > 120 ? userText.slice(0, 120) + "..." : userText;
  return {
    placeholder: true,
    text:
      "This is a placeholder reply. FIDEX AI's brain is not connected yet, " +
      "so no real AI wrote this message.\n\nYour message was received: \"" + preview + "\"",
  };
}
