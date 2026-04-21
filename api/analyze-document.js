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

Zoek expliciet naar deze labels of varianten daarvan:
- Risico Score
- Score van vandaag
- Internationale Score
- Kredietlimiet
- Probability of Default
- Status
- Score omschrijving
- Limiet gewijzigd
- liquide middelen gedaald
- jaarrekening gegevens
- Group / groepsstructuur

Belangrijke regels:
- Als score aanwezig is, zet die in "score"
- Als internationale score A/B/C aanwezig is, zet die in "internationaleScore"
- Als kredietlimiet aanwezig is, zet die in "kredietlimiet"
- Als probability of default aanwezig is, zet die in "probabilityOfDefault"
- Gebruik concrete cijfers exact zoals ze in het document staan
- Laat velden alleen leeg als ze echt niet in de tekst staan
- Geef niet alleen "laag risico" terug als er ook concrete cijfers in het document staan
- "risicoklasse" mag bijvoorbeeld zijn: laag risico, zeer laag risico, A, B etc.
- "bijzonderheden" gebruik je voor opvallende punten zoals limietverlaging, daling liquide middelen of recente wijzigingen

summary:
- 1 zakelijke zin
- noem daarin bij voorkeur score + internationale score + kredietlimiet als die beschikbaar zijn

risks:
- concrete aandachtspunten, bijvoorbeeld:
  - kredietlimiet recent verlaagd
  - liquide middelen gedaald
  - nadere toetsing liquiditeit gewenst

actions:
- concrete vervolgstappen, bijvoorbeeld:
  - vergelijk kredietrapport met jaarrekeningen
  - beoordeel trend in kredietlimiet
  - toets liquiditeitsontwikkeling nader

Voorbeeld van goede output:
{
  "summary": "Sterk kredietprofiel met score 95, internationale score A en kredietlimiet van € 220.000.",
  "fields": {
    "score": "95",
    "risicoklasse": "laag risico",
    "kredietlimiet": "€ 220.000",
    "probabilityOfDefault": "0.03%",
    "internationaleScore": "A",
    "betaalgedrag": "",
    "faillissementen": "",
    "bijzonderheden": "Kredietlimiet recent verlaagd; liquide middelen gedaald"
  },
  "risks": [
    "Kredietlimiet is recent verlaagd",
    "Liquide middelen zijn gedaald"
  ],
  "actions": [
    "Vergelijk kredietrapport met jaarrekeningen",
    "Beoordeel trend in kredietlimiet en liquiditeit"
  ]
}
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
