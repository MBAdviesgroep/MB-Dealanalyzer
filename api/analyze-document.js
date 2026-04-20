export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Alleen POST toegestaan" });
  }

  try {
    const { docType, text } = req.body || {};

    if (!docType || !text || !text.trim()) {
      return res.status(400).json({ error: "docType of tekst ontbreekt" });
    }

    if (docType !== "kvk") {
      return res.status(400).json({ error: "Voor nu is alleen KVK ondersteund" });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: `
Je analyseert een KVK-uittreksel.

Geef ALLEEN geldige JSON terug.
Geen uitleg, geen markdown, geen tekst erbuiten.

Gebruik exact deze structuur:
{
  "summary": "",
  "fields": {
    "bedrijfsnaam": "",
    "rechtsvorm": "",
    "kvkNummer": "",
    "sbiCode": "",
    "oprichtingsdatum": "",
    "vestigingsadres": ""
  },
  "risks": [],
  "actions": []
}

Regels:
- onbekend = leeg laten
- risks is een array van korte zinnen
- actions is een array van korte zinnen
- baseer je alleen op tekst die echt in het document staat
- geen aannames toevoegen
`
          },
          {
            role: "user",
            content: text
          }
        ]
      })
    });

    const data = await response.json();

    let output = "";
    if (data.output && data.output.length > 0) {
      const content = data.output[0].content;
      if (content && content.length > 0) {
        output = content[0].text || "";
      }
    }

let parsed;

try {
  parsed = JSON.parse(output);
} catch (e) {
  return res.status(500).json({
    error: "AI gaf geen geldige JSON terug",
    raw: output
  });
}

res.status(200).json(parsed);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
