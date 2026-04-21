export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Alleen POST toegestaan" });
  }
 
  try {
    const { docType, text } = req.body || {};
 
    if (!docType || !text || !text.trim()) {
      return res.status(400).json({ error: "docType of tekst ontbreekt" });
    }
 
    const SUPPORTED = ["kvk", "graydon", "woz", "kadaster", "jaarrekeningen"];
    if (!SUPPORTED.includes(docType)) {
      return res.status(400).json({ error: `Onbekend docType: ${docType}` });
    }
 
    const systemPrompts = {
 
      kvk: `
Je analyseert een KVK-uittreksel.
Geef ALLEEN geldige JSON terug. Geen uitleg, geen markdown, geen tekst erbuiten.
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
- risks = array van korte NL zinnen over risico’s (ook bij beperkte informatie)
- actions = array van korte NL vervolgacties voor de adviseur
- baseer je alleen op tekst die echt in het document staat
- als informatie beperkt is (alleen KVK), benoem dit als risico (bijv. beperkte financiële transparantie)
- je mag voorzichtige, logische risico-inschattingen maken op basis van ontbrekende informatie
`,
 
graydon: `
Je analyseert een Graydon / Creditsafe kredietrapport.

Geef ALLEEN geldige JSON terug.
Geen uitleg, geen markdown, geen tekst erbuiten.

Gebruik exact deze structuur:

{
  "summary": "",
  "fields": {
    "score": "",
    "risicoklasse": "",
    "kredietlimiet": "",
    "probabilityOfDefault": "",
    "internationaleScore": "",
    "betaalgedrag": "",
    "faillissementen": "",
    "bijzonderheden": ""
  },
  "risks": [],
  "actions": []
}

Regels:
- Gebruik alleen data die letterlijk in het document staat
- Onbekende velden leeg laten
- Gebruik cijfers als die er zijn (heel belangrijk)

BELANGRIJK:
- Als een score aanwezig is (bijv. 95), vul die in bij "score"
- Als kredietlimiet aanwezig is, vul die in bij "kredietlimiet"
- Als probability of default aanwezig is, vul die in
- Als internationale score (A/B/C) aanwezig is, vul die in
- Gebruik NIET alleen "laag risico" als er cijfers beschikbaar zijn

Voorbeeld:
- score = 95
- kredietlimiet = €220.000
- probabilityOfDefault = 0.03%
- internationaleScore = A

summary:
- Combineer belangrijkste info in 1 zin
- Bijvoorbeeld: "Sterk kredietprofiel met score 95 en kredietlimiet €220.000"

risks:
- Benoem concrete risico’s (bijv. daling liquide middelen, limiet verlaagd)

actions:
- Benoem concrete vervolgstappen voor adviseur
`,
 
      woz: `
Je analyseert een WOZ-beschikking of taxatierapport van vastgoed.
Geef ALLEEN geldige JSON terug. Geen uitleg, geen markdown, geen tekst erbuiten.
Gebruik exact deze structuur:
{
  "summary": "",
  "fields": {
    "adresObject": "",
    "wozWaarde": "",
    "taxatiewaarde": "",
    "peildatum": "",
    "bouwjaar": "",
    "oppervlakte": "",
    "documentType": ""
  },
  "risks": [],
  "actions": []
}
Regels:
- documentType alleen: "woz" of "taxatie"
- wozWaarde = WOZ-waarde als getal string zonder euroteken, bv "425000"
- taxatiewaarde = getaxeerde marktwaarde als getal string zonder euroteken
- risks = array van korte NL zinnen over waarderingsrisico's of actualiteitsproblemen
- actions = array van korte NL vervolgacties voor de adviseur
- baseer je alleen op tekst die echt in het document staat
`,
 
      kadaster: `
Je analyseert kadasterinformatie of een eigendomsakte van vastgoed.
Geef ALLEEN geldige JSON terug. Geen uitleg, geen markdown, geen tekst erbuiten.
Gebruik exact deze structuur:
{
  "summary": "",
  "fields": {
    "eigenaar": "",
    "adres": "",
    "koopsom": "",
    "datumLevering": "",
    "hypotheekInschrijving": "",
    "hypotheekBedrag": "",
    "perceelOppervlakte": ""
  },
  "risks": [],
  "actions": []
}
Regels:
- koopsom = bedrag als getal string zonder euroteken, bv "450000"
- hypotheekBedrag = bedrag als getal string zonder euroteken, of leeg
- hypotheekInschrijving alleen: "ja" of "nee"
- risks = array van korte NL zinnen over eigendoms- of hypotheekrisico's
- actions = array van korte NL vervolgacties voor de adviseur
- baseer je alleen op tekst die echt in het document staat
`,
 
      jaarrekeningen: `
Je analyseert een jaarrekening van een onderneming.
Geef ALLEEN geldige JSON terug. Geen uitleg, geen markdown, geen tekst erbuiten.
Gebruik exact deze structuur:
{
  "summary": "",
  "fields": {
    "bedrijfsnaam": "",
    "boekjaar": "",
    "omzet": "",
    "nettowinst": "",
    "ebitda": "",
    "eigenvermogen": "",
    "balanstotaal": "",
    "solvabiliteit": ""
  },
  "risks": [],
  "actions": []
}
Regels:
- alle bedragen als getal string zonder euroteken, bv "1250000"
- solvabiliteit als percentage string, bv "32.4"
- risks = array van korte NL zinnen over financiële risico's voor kredietverstrekking
- actions = array van korte NL vervolgacties voor de adviseur
- baseer je alleen op tekst die echt in het document staat
`
    };
 
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
            content: systemPrompts[docType]
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
      // Strip markdown code fences if present
      const clean = output.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
      parsed = JSON.parse(clean);
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
