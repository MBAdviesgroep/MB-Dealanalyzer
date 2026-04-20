export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Alleen POST toegestaan" });
  }

  try {
    const { text } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Geen tekst ontvangen" });
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
Je haalt dealgegevens uit een financieringsindicatie of vergelijkbaar document.

Geef ALLEEN geldige JSON terug.
Geen uitleg, geen markdown, geen tekst erbuiten.

Gebruik exact deze keys:
{
  "naamKlant": "",
  "typeKlant": "",
  "woonland": "",
  "inkomen": "",
  "vermogen": "",
  "aantalPanden": "",
  "doelFinanciering": "",
  "aankoopprijs": "",
  "marktwaarde": "",
  "huurPerMaand": "",
  "huurType": "",
  "typeVastgoed": "",
  "gewensteLening": "",
  "eigenInbreng": "",
  "rente": "",
  "adviseur": "",
  "dossiernr": ""
}

Regels:
- onbekend = leeg laten
- bedragen zonder euroteken
- gebruik alleen waarden die echt in de tekst staan
- typeKlant alleen: "particulier" of "bv"
- woonland alleen: "nl", "eu" of "buiten-eu"
- doelFinanciering alleen: "aankoop", "herfinanciering" of "overwaarde"
- huurType alleen: "bestaand" of "prognose"
- typeVastgoed alleen: "woning", "bedrijfspand", "horeca", "recreatie", "mixed" of "overig"
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

// 🔥 pak de echte tekst uit de response
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
