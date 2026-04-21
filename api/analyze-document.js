// /api/analyze-document.js
// MB Deal Analyzer — Document analyse backend
// Ondersteunt: kvk, graydon, woz, kadaster, jaarrekeningen

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Alleen POST toegestaan' });
  }

  try {
    const { docType, text } = req.body || {};

    if (!docType || !text || !text.trim()) {
      return res.status(400).json({ error: 'docType of tekst ontbreekt' });
    }

    const SUPPORTED = ['kvk', 'graydon', 'woz', 'kadaster', 'jaarrekeningen'];
    if (!SUPPORTED.includes(docType)) {
      return res.status(400).json({ error: `Onbekend docType: ${docType}` });
    }

    // ──────────────────────────────────────────────────────────────
    // STAP 1 — Regex fallback extraction (altijd uitvoeren)
    // Levert gegarandeerde basiswaarden als AI tekortschiet
    // ──────────────────────────────────────────────────────────────
    const fallback = extractFallback(docType, text);

    // ──────────────────────────────────────────────────────────────
    // STAP 2 — AI extractie via OpenAI
    // Meer tekst meesturen dan voorheen (tot 25.000 tekens)
    // Truncatie is per type iets anders: financiële docs
    // hebben hun kerndata vaak vroeg in het document
    // ──────────────────────────────────────────────────────────────
    const truncated = smartTruncate(docType, text);
    const systemPrompt = SYSTEM_PROMPTS[docType];

    let aiResult = null;
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          input: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: truncated }
          ]
        })
      });

      const data = await response.json();
      let raw = '';
      if (data.output?.[0]?.content?.[0]?.text) {
        raw = data.output[0].content[0].text;
      }

      if (raw) {
        const clean = raw
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();
        aiResult = JSON.parse(clean);
      }
    } catch (aiErr) {
      console.warn(`[analyze-document] AI mislukt voor ${docType}:`, aiErr.message);
    }

    // ──────────────────────────────────────────────────────────────
    // STAP 3 — Merge: AI output + fallback
    // AI heeft prioriteit, fallback vult lege velden aan
    // ──────────────────────────────────────────────────────────────
    const merged = mergeResults(docType, aiResult, fallback);

    return res.status(200).json(merged);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ──────────────────────────────────────────────────────────────────
// SMART TRUNCATE
// Per documenttype een zinvolle tekstgrens instellen.
// Graydon/jaarrekeningen bevatten kerndata over een groter bereik;
// WOZ/kadaster zijn doorgaans korter en dichten bij het begin.
// ──────────────────────────────────────────────────────────────────
function smartTruncate(docType, text) {
  const limits = {
    kvk:           20000,
    graydon:       28000,   // scores, PD, limieten kunnen diep in rapport staan
    woz:           18000,
    kadaster:      18000,
    jaarrekeningen:28000    // meerdere jaren, veel cijfers
  };
  const limit = limits[docType] || 20000;
  return text.length > limit ? text.substring(0, limit) : text;
}

// ──────────────────────────────────────────────────────────────────
// MERGE: AI + fallback
// Lege AI-velden worden ingevuld met fallback-waarden.
// summary en risks/actions: als AI leeg → fallback overnemen.
// ──────────────────────────────────────────────────────────────────
function mergeResults(docType, ai, fallback) {
  // Als AI helemaal niets bruikbaars teruggaf → volledig fallback
  if (!ai || typeof ai !== 'object') {
    return fallback;
  }

  const merged = {
    summary: ai.summary || fallback.summary || '',
    fields:  { ...(fallback.fields || {}), ...(ai.fields || {}) },
    risks:   (ai.risks?.length   ? ai.risks   : fallback.risks)  || [],
    actions: (ai.actions?.length ? ai.actions : fallback.actions) || []
  };

  // Lege velden in AI fields aanvullen met fallback
  const fb = fallback.fields || {};
  Object.keys(fb).forEach(k => {
    if (!merged.fields[k] || String(merged.fields[k]).trim() === '') {
      merged.fields[k] = fb[k];
    }
  });

  return merged;
}

// ──────────────────────────────────────────────────────────────────
// REGEX FALLBACK EXTRACTION per documenttype
// ──────────────────────────────────────────────────────────────────
function extractFallback(docType, text) {
  switch (docType) {
    case 'kvk':           return fallbackKvk(text);
    case 'graydon':       return fallbackGraydon(text);
    case 'woz':           return fallbackWoz(text);
    case 'kadaster':      return fallbackKadaster(text);
    case 'jaarrekeningen':return fallbackJaarrekening(text);
    default:              return { summary: '', fields: {}, risks: [], actions: [] };
  }
}

function rx(text, patterns) {
  for (const p of (Array.isArray(patterns) ? patterns : [patterns])) {
    const m = text.match(p);
    if (m) return (m[1] || m[0]).trim();
  }
  return '';
}

function rxBedrag(text, patterns) {
  const raw = rx(text, patterns);
  if (!raw) return '';
  // Normaliseer: "€ 220.000" of "220,000" of "220000" → "220000"
  return raw.replace(/[€\s]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.').replace(/[^0-9.]/g, '');
}

// ── KVK ──────────────────────────────────────────────────────────
function fallbackKvk(t) {
  const rv = rx(t, [/\b(besloten\s+vennootschap|BV|B\.V\.|naamloze\s+vennootschap|NV|N\.V\.|eenmanszaak|VOF|maatschap)\b/i]);
  const kvkNr = rx(t, /KVK[-\s]?(?:nummer|nr\.?)?[\s:]*(\d{8})/i);
  const naam = rx(t, [/(?:handelsnaam|bedrijfsnaam|onderneming)[\s:]+([^\n]{2,60})/i]);
  const opr = rx(t, /(?:opgericht|oprichtingsdatum)[\s:]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/i);
  const sbi = rx(t, /SBI[-\s]?(?:code)?[\s:]*(\d{4,5})/i);
  return {
    summary: naam ? `${naam}${rv ? ' — ' + rv : ''}${kvkNr ? ', KVK ' + kvkNr : ''}` : '',
    fields: { bedrijfsnaam: naam, rechtsvorm: rv, kvkNummer: kvkNr, sbiCode: sbi, oprichtingsdatum: opr, vestigingsadres: '' },
    risks: rv ? [] : ['Rechtsvorm niet herkend in document'],
    actions: ['Controleer KVK-uittreksel op actualiteit (max. 3 maanden)']
  };
}

// ── GRAYDON / KREDIETRAPPORT ─────────────────────────────────────
function fallbackGraydon(t) {
  // Score: diverse patronen — numeriek of letter
  const score = rx(t, [
    /(?:risico\s*score|credit\s*score|score\s+van\s+vandaag|score)[\s:]*([0-9]{1,3})/i,
    /\bscore[\s:]+([0-9]{1,3})\b/i,
    /\b([0-9]{1,3})\s*\/\s*100\b/
  ]);
  const intScore = rx(t, [
    /(?:internationale?\s*score|international\s*score)[\s:]*([A-D][+\-]?)/i,
    /\bAAA\b|\bAA\b|\b(?<![0-9])A\b(?![0-9])/   // terugval op letterscores
  ]);
  const klasse = rx(t, [
    /(?:risicoklasse|risico\s*omschrijving|score\s*omschrijving)[\s:]+([^\n,;]{3,40})/i,
    /\b(zeer\s+laag\s+risico|laag\s+risico|gemiddeld\s+risico|hoog\s+risico|verhoogd\s+risico)\b/i
  ]);
  const limiet = rxBedrag(t, [
    /(?:kredietlimiet|aanbevolen\s+krediet(?:limiet)?|limiet)[\s:€]*([0-9][0-9.,\s]{2,12})/i,
    /(?:limiet\s+gewijzigd[\s\S]{0,60}?naar)[\s€:]*([0-9][0-9.,\s]{2,10})/i
  ]);
  const pd = rx(t, [
    /(?:probability\s+of\s+default|PD|kans\s+op\s+faillissement)[\s:]*([0-9.,]+\s*%)/i,
    /\bPD[\s:]+([0-9.,]+\s*%)/i
  ]);
  const betaal = rx(t, [
    /(?:betalingsgedrag|betaalgedrag|betalingservaring)[\s:]+([^\n]{5,80})/i
  ]);
  const faillis = rx(t, /(?:faillissement(?:en)?)[\s:]+([^\n]{3,60})/i);

  // Bijzonderheden: pik signalen op
  const signalen = [];
  if (/limiet\s+(?:verlaagd|gedaald|gewijzigd)/i.test(t)) signalen.push('Kredietlimiet recent verlaagd');
  if (/liquide\s+middelen\s+(?:gedaald|verlaagd|afgenomen)/i.test(t)) signalen.push('Liquide middelen gedaald');
  if (/negatief\s+eigen\s+vermogen/i.test(t)) signalen.push('Negatief eigen vermogen');
  if (/betalingsachterstand|incasso|deurwaarder/i.test(t)) signalen.push('Betaalproblemen gesignaleerd');

  const summary = [
    score ? `Score ${score}` : '',
    intScore ? `internationale score ${intScore}` : '',
    limiet ? `kredietlimiet €${parseInt(limiet.replace(/[^0-9]/g,'')).toLocaleString('nl-NL')}` : '',
    klasse || ''
  ].filter(Boolean).join(', ');

  const risks = [...signalen];
  if (!score && !klasse) risks.push('Score of risicoklasse niet herkend — controleer document');

  return {
    summary: summary || '',
    fields: {
      score, risicoklasse: klasse, kredietlimiet: limiet ? limiet : '',
      probabilityOfDefault: pd, internationaleScore: intScore,
      betaalgedrag: betaal, faillissementen: faillis,
      bijzonderheden: signalen.join('; ')
    },
    risks,
    actions: [
      'Vergelijk kredietrapport met jaarrekeningen',
      'Beoordeel trend in kredietlimiet',
      ...(signalen.length ? ['Toets liquiditeitsontwikkeling nader'] : [])
    ]
  };
}

// ── WOZ / TAXATIE ────────────────────────────────────────────────
function fallbackWoz(t) {
  const taxIndicatoren = ['taxatiewaarde', 'taxatierapport', 'nwwi', 'nvm', 'rics', 'mrics', 'taxateur'];
  const isTaxatie = taxIndicatoren.some(kw => t.toLowerCase().includes(kw));

  const wozW = rxBedrag(t, [
    /(?:WOZ[-\s]?waarde|vastgestelde\s+waarde)[\s:€]*([0-9][0-9.,\s]{4,14})/i
  ]);
  const taxW = rxBedrag(t, [
    /(?:(?:getaxeerde?\s+)?marktwaarde|taxatiewaarde|onderhandse\s+verkoopwaarde)[\s:€]*([0-9][0-9.,\s]{4,14})/i
  ]);
  const waarde = taxW || wozW;
  const peildatum = rx(t, [
    /(?:waardepeildatum|peildatum|taxatiedatum|waarderingsdatum)[\s:]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{1,2}\s+\w+\s+\d{4})/i
  ]);
  const adres = rx(t, [
    /(?:objectadres|adres\s+object|locatie)[\s:]+([^\n]{5,60})/i,
    /(?:betreft|gelegen\s+(?:aan|te))[\s:]+([^\n]{5,60})/i
  ]);
  const bouwjaar = rx(t, /(?:bouwjaar|gebouwd\s+in)[\s:]+(\d{4})/i);
  const opp = rx(t, /(?:gebruiksoppervlakte?|woonoppervlakte?|oppervlakte)[\s:]+(\d+)\s*m²?/i);
  const taxateur = rx(t, /(?:taxateur|opgesteld\s+door|gecertificeerd\s+door)[\s:]+([^\n]{3,60})/i);

  const risks = [];
  if (!waarde) risks.push('Waardevaststelling niet herkend — controleer document');
  if (!peildatum) risks.push('Peildatum niet gevonden — controleer actualiteit');
  else {
    const jaar = parseInt(peildatum.match(/\d{4}/)?.[0]);
    if (jaar && new Date().getFullYear() - jaar > 1) risks.push(`Peildatum ${peildatum} is mogelijk te oud (>1 jaar)`);
  }

  return {
    summary: waarde ? `${isTaxatie ? 'Taxatiewaarde' : 'WOZ-waarde'} ${adres ? adres + ': ' : ''}€${parseInt(waarde).toLocaleString('nl-NL')}${peildatum ? ', peildatum ' + peildatum : ''}` : '',
    fields: {
      adresObject: adres,
      wozWaarde:    isTaxatie ? '' : waarde,
      taxatiewaarde:isTaxatie ? waarde : '',
      peildatum,
      bouwjaar,
      oppervlakte: opp ? opp + ' m²' : '',
      documentType: isTaxatie ? 'taxatie' : 'woz',
      taxateur
    },
    risks,
    actions: [
      'Controleer actualiteit waardering (max 6 maanden voor bancaire indiening)',
      ...(isTaxatie ? ['Controleer of taxatie NWWI-gecertificeerd is'] : [])
    ]
  };
}

// ── KADASTER ─────────────────────────────────────────────────────
function fallbackKadaster(t) {
  const eigenaar = rx(t, [
    /(?:eigenaar|t\.n\.v\.|ten\s+name\s+van)[\s:]+([^\n,;]{3,70})/i,
    /(?:geleverd\s+aan|verkocht\s+aan)[\s:]+([^\n,;]{3,60})/i
  ]);
  const adres = rx(t, [
    /(?:kadastraal\s+adres|perceeladres|objectadres|gelegen\s+(?:aan|te))[\s:]+([^\n]{5,60})/i
  ]);
  const koopsom = rxBedrag(t, [
    /(?:koopsom|koopprijs|verkoopprijs|verkoopsom)[\s:€]*([0-9][0-9.,\s]{4,14})/i
  ]);
  const levDatum = rx(t, [
    /(?:datum\s+levering|leveringsdatum|gepasseerd\s+op|akte\s+van\s+levering\s+d\.d\.)[\s:]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{1,2}\s+\w+\s+\d{4})/i
  ]);
  const hypBedrag = rxBedrag(t, [
    /(?:hypotheek(?:inschrijving|recht|bedrag)?)[\s:€]*([0-9][0-9.,\s]{4,14})/i
  ]);
  const heeftHyp = !!hypBedrag ||
    (t.toLowerCase().includes('hypotheek') && !/(geen|nihil|nvt)/i.test(t.substring(t.toLowerCase().indexOf('hypotheek'), t.toLowerCase().indexOf('hypotheek') + 80)));
  const perceel = rx(t, /(?:perceeloppervlakte|oppervlakte\s+perceel)[\s:]+(\d+)\s*m²?/i);

  const risks = [];
  if (heeftHyp) risks.push('Bestaande hypotheekinschrijving aanwezig — rangorde aandachtspunt');
  if (!eigenaar) risks.push('Eigenaar niet herkend — verifieer eigendomssituatie');

  return {
    summary: [eigenaar ? `Eigenaar: ${eigenaar}` : '', adres || '', koopsom ? `koopsom €${parseInt(koopsom).toLocaleString('nl-NL')}` : ''].filter(Boolean).join(', '),
    fields: {
      eigenaar, adres, koopsom,
      datumLevering: levDatum,
      hypotheekInschrijving: heeftHyp ? 'ja' : 'nee',
      hypotheekBedrag: hypBedrag || '',
      perceelOppervlakte: perceel ? perceel + ' m²' : ''
    },
    risks,
    actions: [
      ...(heeftHyp ? ['Verifieer omvang en rang bestaande hypotheek via notaris'] : []),
      'Controleer of eigenaar overeenkomt met klantprofiel'
    ]
  };
}

// ── JAARREKENINGEN ───────────────────────────────────────────────
function fallbackJaarrekening(t) {
  const jaren = [...new Set((t.match(/\b(20\d{2})\b/g) || []).filter(j => parseInt(j) >= 2015 && parseInt(j) <= 2030))].sort().reverse();
  const jaar = jaren[0] || '';
  const naam = rx(t, /(?:naam\s+onderneming|bedrijfsnaam|handelsnaam|opgesteld\s+voor)[\s:]+([^\n]{2,60})/i);
  const omzet = rxBedrag(t, [
    /(?:netto[-\s]?omzet|omzet)[\s:€x]*([\d.,\s]{4,16})/i
  ]);
  const ebitda = rxBedrag(t, [
    /(?:ebitda|bedrijfsresultaat\s+voor\s+afschrijving)[\s:€x]*([\d.,\s]{4,16})/i
  ]);
  const nettowinst = rxBedrag(t, [
    /(?:netto(?:winst|resultaat)|resultaat\s+(?:na\s+belasting|boekjaar))[\s:€x]*([-\d.,\s]{4,16})/i
  ]);
  const ev = rxBedrag(t, [
    /(?:eigen\s+vermogen|totaal\s+eigen\s+vermogen)[\s:€x]*([-\d.,\s]{4,16})/i
  ]);
  const bt = rxBedrag(t, [
    /(?:balanstotaal|totaal\s+activa|totaal\s+passiva)[\s:€x]*([\d.,\s]{4,16})/i
  ]);
  // Solvabiliteit berekenen als ev en bt beschikbaar
  let solvab = rx(t, /(?:solvabiliteit(?:sratio)?)[\s:]+([0-9.,]+)\s*%?/i);
  if (!solvab && ev && bt && parseFloat(bt) > 0) {
    solvab = ((parseFloat(ev) / parseFloat(bt)) * 100).toFixed(1);
  }

  const risks = [];
  if (nettowinst && parseFloat(nettowinst) < 0) risks.push('Negatief nettoresultaat — rentabiliteitszorg');
  if (solvab && parseFloat(solvab) < 20) risks.push(`Lage solvabiliteit (${solvab}%) — bancaire norm ligt doorgaans hoger`);
  if (!omzet) risks.push('Omzet niet herkend in document — controleer kwaliteit upload');

  return {
    summary: [naam || '', jaar ? `boekjaar ${jaar}` : '', omzet ? `omzet €${parseInt(omzet).toLocaleString('nl-NL')}` : '', nettowinst ? `nettoresultaat €${parseInt(nettowinst).toLocaleString('nl-NL')}` : ''].filter(Boolean).join(', '),
    fields: {
      bedrijfsnaam: naam, boekjaar: jaar,
      omzet, ebitda, nettowinst,
      eigenvermogen: ev, balanstotaal: bt,
      solvabiliteit: solvab
    },
    risks,
    actions: [
      'Vergelijk meerdere jaren voor trendanalyse',
      ...(risks.length ? ['Bespreek financiële signalen met klant vóór indiening'] : [])
    ]
  };
}

// ──────────────────────────────────────────────────────────────────
// SYSTEM PROMPTS — extraction-first, concrete velden, voorbeeldoutput
// ──────────────────────────────────────────────────────────────────
const SYSTEM_PROMPTS = {

kvk: `Je analyseert een KVK-uittreksel.
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
- onbekend = leeg laten ("")
- kvkNummer = 8-cijferig getal als string
- sbiCode = 4–5-cijferig getal als string
- risks = array van korte NL zinnen over risico's
- actions = array van korte NL vervolgacties voor de adviseur
- gebruik alleen tekst die echt in het document staat`,

graydon: `Je analyseert een Graydon / CreditSafe / kredietrapport.
Geef ALLEEN geldige JSON terug. Geen uitleg, geen markdown, geen tekst erbuiten.

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

Zoek expliciet naar deze labels (inclusief varianten):
- "Risico Score", "Score van vandaag", "score" → vul in "score" als getal 0–100
- "Internationale Score", "International Score", letter A/B/C/D → vul in "internationaleScore"
- "Kredietlimiet", "Aanbevolen krediet", "Limiet" → vul in "kredietlimiet" als bedrag met €-teken
- "Probability of Default", "PD", "kans op faillissement" → vul in "probabilityOfDefault" met %-teken
- "Status", "Score omschrijving", "Risicoklasse" → vul in "risicoklasse"
- "Betalingsgedrag", "Betalingservaring" → vul in "betaalgedrag"
- Signalen als "limiet verlaagd", "liquide middelen gedaald", "negatief eigen vermogen" → vul in "bijzonderheden"

Regels:
- onbekend = leeg laten ("")
- gebruik CONCRETE CIJFERS exact zoals ze in het document staan
- vul "risicoklasse" in als "laag risico" / "gemiddeld risico" / "hoog risico" of de lettercode
- "bijzonderheden" = aaneengesloten tekst van opvallende signalen
- risks = concrete aandachtspunten gebaseerd op de data (niet generiek)
- actions = concrete vervolgstappen voor de adviseur

Voorbeeld van goede output:
{
  "summary": "Sterk kredietprofiel: score 95, internationale score A, kredietlimiet €220.000.",
  "fields": {
    "score": "95",
    "risicoklasse": "laag risico",
    "kredietlimiet": "€ 220.000",
    "probabilityOfDefault": "0.03%",
    "internationaleScore": "A",
    "betaalgedrag": "Geen bijzonderheden",
    "faillissementen": "",
    "bijzonderheden": "Kredietlimiet recent verlaagd; liquide middelen gedaald"
  },
  "risks": ["Kredietlimiet is recent verlaagd", "Liquide middelen zijn gedaald"],
  "actions": ["Vergelijk rapport met jaarrekeningen", "Beoordeel trend in kredietlimiet en liquiditeit"]
}`,

woz: `Je analyseert een WOZ-beschikking of taxatierapport van vastgoed.
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
    "documentType": "",
    "taxateur": ""
  },
  "risks": [],
  "actions": []
}

Regels:
- documentType: alleen "woz" of "taxatie"
- wozWaarde: alleen invullen als het een WOZ-beschikking is, als getal zonder €-teken, bv "425000"
- taxatiewaarde: alleen invullen als het een taxatierapport is, als getal zonder €-teken, bv "450000"
- peildatum: datum als string, bv "01-01-2024"
- bouwjaar: 4-cijferig jaar als string
- oppervlakte: met m², bv "125 m²"
- risks = concrete waarderingsrisico's of actualiteitsproblemen
- actions = concrete vervolgstappen

Zoek naar:
- "WOZ-waarde", "vastgestelde waarde" → wozWaarde
- "marktwaarde", "taxatiewaarde", "onderhandse verkoopwaarde" → taxatiewaarde
- "waardepeildatum", "peildatum", "taxatiedatum" → peildatum
- objectadres, perceeladres, gelegen aan → adresObject
- taxateur, opgesteld door → taxateur`,

kadaster: `Je analyseert kadasterinformatie of een eigendomsakte van vastgoed.
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
- koopsom: getal als string zonder €-teken, bv "450000"
- hypotheekBedrag: getal als string zonder €-teken, of leeg
- hypotheekInschrijving: alleen "ja" of "nee"
- datumLevering: datum als string
- risks = eigendoms- of hypotheekrisico's
- actions = concrete vervolgstappen

Zoek naar:
- "eigenaar", "t.n.v.", "ten name van", "geleverd aan" → eigenaar
- "kadastraal adres", "perceeladres", "objectadres" → adres
- "koopsom", "koopprijs", "verkoopsom" → koopsom
- "datum levering", "leveringsdatum", "gepasseerd op" → datumLevering
- "hypotheek", "hypotheekinschrijving", "hypotheekrecht" → hypotheekInschrijving / hypotheekBedrag`,

jaarrekeningen: `Je analyseert een jaarrekening van een onderneming.
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
- alle bedragen: getallen als string zonder €-teken of punt-duizendtalscheiding, bv "1250000"
- negatieve bedragen: met minteken, bv "-45000"
- solvabiliteit: percentage als getal string zonder %-teken, bv "32.4"
- boekjaar: 4-cijferig jaar als string
- risks = financiële risico's voor kredietverstrekking (concreet, gebaseerd op cijfers)
- actions = concrete vervolgstappen

Zoek naar:
- "netto-omzet", "omzet" → omzet
- "EBITDA", "bedrijfsresultaat voor afschrijving" → ebitda
- "resultaat na belasting", "nettoresultaat", "netto winst/verlies" → nettowinst
- "eigen vermogen", "totaal eigen vermogen" → eigenvermogen
- "balanstotaal", "totaal activa", "totaal passiva" → balanstotaal
- "solvabiliteit", "solvabiliteitsratio" → solvabiliteit

Als solvabiliteit niet expliciet staat maar eigen vermogen en balanstotaal wel:
bereken dan: solvabiliteit = (eigenvermogen / balanstotaal) * 100, afgerond op 1 decimaal`

};
