// lib/groqClient.js
const crypto = require('crypto');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_ID = "llama-3.3-70b-versatile";

/**
 * Computes a SHA-256 hash for caching keys.
 */
function computeHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Robustly calls Groq AI and handles JSON parsing logic.
 * @param {string} systemPrompt - The system instruction.
 * @param {string} userPrompt - The user request.
 * @param {boolean} jsonMode - Whether to enforce JSON output.
 * @returns {Promise<Object|string>} - Parsed JSON object or raw string.
 */
async function callGroqAI(systemPrompt, userPrompt, jsonMode = false) {
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY environment variable.");

  const payload = {
    model: MODEL_ID,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.5, // Balance creativity and deterministic output
  };

  if (jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API Error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || "";

    // 🛡️ Robust Parsing: Strip Markdown code blocks if present
    if (jsonMode) {
      content = content.replace(/```json|```/g, '').trim();
      try {
        return JSON.parse(content);
      } catch (parseErr) {
        console.error("JSON Parse failed on:", content);
        throw new Error("AI returned invalid JSON. Please try again.");
      }
    }

    return content;
  } catch (error) {
    console.error("callGroqAI Error:", error);
    throw error;
  }
}

// Simple safety filter (expand list as needed)
function isUnsafe(text) {
  const BAD_WORDS = ['hate', 'violence', 'explicit', 'kill', 'suicide']; // Add distinct list
  const lower = text.toLowerCase();
  return BAD_WORDS.some(word => lower.includes(word));
}

module.exports = { callGroqAI, computeHash, isUnsafe, MODEL_ID };
