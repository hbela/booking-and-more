import type { LegalDocument } from "./types";

export const privacyHu: LegalDocument = {
  title: "Adatkezelési tájékoztató",
  effective: "2026-11-01",
  intro: [
    "Jelen tájékoztató bemutatja, hogyan kezeli a személyes adatokat a Booking and More üzemeltetője, akit az oldal alján található impresszum nevez meg. Két minőségben járunk el: adatkezelőként a Szolgáltatást használó vállalkozások és munkatársaik adatai tekintetében (2. és 3. pont), és adatfeldolgozóként e vállalkozások saját ügyfeleinek, például pácienseinek adatai tekintetében (4. pont).",
  ],
  sections: [
    {
      id: "controller",
      heading: "1. Az adatkezelő",
      blocks: [
        "Az adatkezelő az alábbi impresszumban megnevezett üzemeltető. A személyes adatokkal kapcsolatos kérelmeket az ott feltüntetett e-mail-címre lehet küldeni.",
      ],
    },
    {
      id: "staff",
      heading: "2. Tulajdonosok, szolgáltatók és asszisztensek",
      blocks: [
        "Kezelt adatok: név, e-mail-cím, a jelszó egyirányú kódolt (hash) változata, a bejelentkezési munkamenetek, a szervezetekhez tartozás és a szerepkörök, valamint az irányítópulton végzett fontosabb módosítások naplója.",
        "Cél és jogalap: a fiók és a Szolgáltatás biztosítása a szerződés teljesítéséhez (GDPR 6. cikk (1) b) pont), valamint a Szolgáltatás biztonsága (6. cikk (1) f) pont, a visszaélések megelőzéséhez fűződő jogos érdekünk).",
        "Megőrzés: a fiók fennállásáig; a szervezet szerződésének megszűnése után az ÁSZF 12. pontja szerint.",
      ],
    },
    {
      id: "billing",
      heading: "3. Számlázás",
      blocks: [
        "Kezelt adatok: a fizetéskor megadott számlázási név, cím és adószám, az előfizetés és fizetési állapota, valamint a kiállított számlák.",
        "A kártyaadatokat a Stripe fizetési oldalán kell megadni, azokat kizárólag a Stripe kezeli, hozzánk nem jutnak el.",
        "Cél és jogalap: a szerződés teljesítése (6. cikk (1) b) pont), valamint a számviteli és adózási kötelezettségek teljesítése (6. cikk (1) c) pont). A számlákat a számvitelről szóló 2000. évi C. törvény 169. §-a alapján 8 évig őrizzük meg.",
      ],
    },
    {
      id: "patients",
      heading: "4. A vállalkozások ügyfelei (adatfeldolgozás)",
      blocks: [
        "Ha valaki a Booking and More-on keresztül foglal időpontot egy vállalkozásnál, adatainak kezelője az a vállalkozás, és annak adatkezelési tájékoztatója az irányadó. Az adatokat a vállalkozás megbízásából, kizárólag az utasításai szerint, a Szolgáltatás nyújtásához dolgozzuk fel. Az ezekkel az adatokkal kapcsolatos kérelmeket a vállalkozáshoz kell intézni; ha hozzánk érkezik ilyen, továbbítjuk.",
        "Kezelt adatok: név, e-mail-cím, telefonszám, a foglaláshoz fűzött megjegyzés, maguk a foglalások, és ha a vállalkozás használja az MI-asszisztenst, a chatüzenetek.",
        "Az adatfeldolgozás módja:",
        {
          list: [
            "A neveket és elérhetőségeket az adatbázisban titkosítva tároljuk.",
            "A foglalási e-maileket a vállalkozás nevében küldjük.",
            "A chatüzenetek tartalmát a beszélgetés után 90 nappal töröljük.",
            "Egy vállalkozás ügyfeleit csak a saját munkatársai látják, más szervezetek nem.",
            "Az 5. pontban felsorolt adatfeldolgozókat vesszük igénybe, és új adatfeldolgozó bevonása előtt tájékoztatjuk a vállalkozásokat.",
            "Segítjük a vállalkozást ügyfelei kérelmeinek teljesítésében és az incidensek kezelésében, a szerződés megszűnésekor pedig az ÁSZF szerint töröljük vagy visszaadjuk az adatokat.",
          ],
        },
      ],
    },
    {
      id: "processors",
      heading: "5. Adatfeldolgozók",
      blocks: [
        {
          list: [
            "Hetzner Online GmbH (Németország): az alkalmazás és az adatbázis tárhelye.",
            "Cloudflare, Inc.: a titkosított mentések tárolása.",
            "Stripe Payments Europe, Ltd. (Írország): kártyás fizetés és előfizetések.",
            "Billingo Technologies Zrt. (Magyarország): számlázás és a számlák NAV-hoz továbbítása.",
            "Resend, Inc. (USA): e-mailek küldése.",
            "Functional Software, Inc. (Sentry), uniós adatrégió: hibajelentések, a személyes adatok küldés előtti eltávolításával.",
            "Anthropic, PBC (USA): az MI chat-asszisztens, kizárólag a Professional csomagot használó vállalkozásoknál.",
          ],
        },
        "Az Európai Gazdasági Térségen kívülre történő adattovábbítás az Európai Bizottság általános szerződési feltételein vagy az EU–USA adatvédelmi keretrendszeren alapul.",
      ],
    },
    {
      id: "cookies",
      heading: "6. Sütik",
      blocks: [
        "Csak a Szolgáltatás működéséhez szükséges sütiket használunk: a bejelentkezési munkamenetet, valamint a választott nyelvet és színtémát. Reklám- és analitikai sütiket nem használunk.",
        "Ha a böngészőben hiba történik, hibajelentés megy a Sentry felé. Ez tartalmazhat a képernyőről készült felvételt, amelyen minden szöveg, beviteli mező és kép el van rejtve.",
      ],
    },
    {
      id: "security",
      heading: "7. Biztonság és mentések",
      blocks: [
        "A kapcsolat titkosított (HTTPS). Az ügyfelek nevét és elérhetőségét az adatbázisban titkosítva tároljuk. Mentés 30 percenként készül, titkosítva, külső helyszínen; a mentéseket 7 napig teljes egészében, 30 napig napi egy példányban őrizzük. Ha egy mentést valaha visszaállítunk, az azt követően végrehajtott törléseket újra végrehajtjuk.",
      ],
    },
    {
      id: "rights",
      heading: "8. Az érintettek jogai",
      blocks: [
        "Kérheti adataihoz való hozzáférést, azok helyesbítését vagy törlését, kezelésük korlátozását és hordozható formátumú másolatukat, valamint tiltakozhat a jogos érdeken alapuló adatkezelés ellen. Kérelmére egy hónapon belül válaszolunk.",
        "Panaszt tehet a Nemzeti Adatvédelmi és Információszabadság Hatóságnál (NAIH, 1055 Budapest, Falk Miksa utca 9–11., www.naih.hu), vagy bírósághoz fordulhat.",
      ],
    },
    {
      id: "incidents",
      heading: "9. Adatvédelmi incidens",
      blocks: [
        "Adatvédelmi incidens esetén, ha a jogszabály előírja, 72 órán belül bejelentjük a NAIH-nak, az érintett vállalkozásokat indokolatlan késedelem nélkül tájékoztatjuk, és az érintetteket is értesítjük, ha az incidens valószínűleg magas kockázattal jár rájuk nézve.",
      ],
    },
    {
      id: "changes",
      heading: "10. Módosítás",
      blocks: [
        "A tájékoztató módosításait ezen az oldalon tesszük közzé, és az előfizető vállalkozásokat e-mailben értesítjük.",
      ],
    },
  ],
};
