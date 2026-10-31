import type { LegalDocument } from "./types";

export const termsHu: LegalDocument = {
  title: "Általános Szerződési Feltételek",
  effective: "2026-11-01",
  intro: [
    "Jelen Általános Szerződési Feltételek (ÁSZF) a Booking and More online időpontfoglaló szolgáltatás (a „Szolgáltatás”) igénybevételének feltételeit rögzítik az oldal alján, az impresszumban megnevezett üzemeltető (a „Szolgáltató”) és a fiókot létrehozó, előfizető vállalkozás (az „Előfizető”) között.",
  ],
  sections: [
    {
      id: "scope",
      heading: "1. Kinek szól a Szolgáltatás",
      blocks: [
        "A Szolgáltatás vállalkozásoknak szól: rendelőknek, praxisoknak és más, időpontra dolgozó szolgáltatóknak. Fogyasztók részére nem nyújtjuk. Aki tulajdonosi fiókot hoz létre és előfizet, a vállalkozás nevében teszi, és kijelenti, hogy erre jogosult.",
        "Az Előfizető ügyfelei (például páciensei) a nyilvános foglalási oldalakat díjmentesen használják. Ők nem a Szolgáltatóval, hanem az Előfizetővel állnak jogviszonyban.",
      ],
    },
    {
      id: "service",
      heading: "2. A Szolgáltatás",
      blocks: [
        "A Szolgáltatás minden szervezetnek nyilvános foglalási oldalt, a szolgáltatások, szolgáltatók, helyszínek, munkaidők és foglalások kezelésére irányítópultot, telefonra telepíthető munkatársi alkalmazást, valamint foglalási visszaigazoló, módosítási és emlékeztető e-maileket biztosít.",
        "A Professional és Professional Plus csomag ezen felül MI-alapú chat-asszisztenst is tartalmaz, amely kérdésekre válaszol és időpontot foglal, az Árak oldalon feltüntetett havi és napi chatkereten belül.",
        "A Szolgáltatást fejleszthetjük és módosíthatjuk. Egy csomag alapvető funkcióját nem szüntetjük meg olyan időszak alatt, amelyet az Előfizető már kifizetett.",
      ],
    },
    {
      id: "account",
      heading: "3. Fiókok",
      blocks: [
        "A tulajdonosi fiók kezeli a szervezetet, és meghívhat szolgáltatókat és asszisztenseket. Az Előfizető felel az általa meghívott személyekért, a jelszavak titokban tartásáért és az általa megadott adatok helyességéért.",
        "Egy előfizetés egy szervezetre vonatkozik.",
      ],
    },
    {
      id: "prices",
      heading: "4. Árak és fizetés",
      blocks: [
        "A csomagok árát az Árak oldal tartalmazza, forintban, havonta. A Szolgáltató alanyi adómentes, ezért áfát nem számít fel.",
        "A díjat havonta előre, bankkártyával, a Stripe-on keresztül kell megfizetni. A kártyaadatokat a Stripe fizetési oldalán kell megadni, azok a Szolgáltatóhoz nem jutnak el. Minden sikeres fizetés után a Szolgáltató a Billingón keresztül elektronikus számlát állít ki, amelyet a Billingo a NAV-nak továbbít.",
        "A támogatott beállítás egyszeri, választható szolgáltatás az Árak oldalon szereplő díjért, amelyről a munka megkezdése előtt külön állapodunk meg.",
      ],
    },
    {
      id: "trial",
      heading: "5. Ingyenes próbaidőszak",
      blocks: [
        "Minden szervezet egy alkalommal vehet igénybe ingyenes próbaidőszakot, az előfizetéskor feltüntetett hosszban. A kártyát a próbaidőszak elején kell megadni, terhelés azonban csak a próbaidőszak végén történik. Ha az Előfizető a próbaidőszak vége előtt lemondja az előfizetést, semmilyen terhelés nem történik.",
      ],
    },
    {
      id: "changes",
      heading: "6. Csomagváltás és lemondás",
      blocks: [
        "Az Előfizető az előfizetését az irányítópult Előfizetés oldaláról, a Stripe ügyfélportálján kezeli:",
        {
          list: [
            "A magasabb csomagra váltás azonnal hatályos; a folyó időszak hátralévő részére eső különbözetet időarányosan terheljük.",
            "Az alacsonyabb csomagra váltás a folyó időszak végén lép hatályba.",
            "A lemondás a kifizetett időszak végén lép hatályba. A Szolgáltatás addig elérhető marad, további terhelés nem történik.",
          ],
        },
        "A visszatérítés szabályait a Lemondás és visszatérítés oldal tartalmazza.",
      ],
    },
    {
      id: "failed-payments",
      heading: "7. Sikertelen fizetés",
      blocks: [
        "Sikertelen fizetés esetén a Stripe a következő napokban újrapróbálja a terhelést, a Szolgáltatás addig elérhető marad. Ha a fizetés nem sikerül, az előfizetés megszűnik, a szervezet felfüggesztésre kerül: foglalási oldalai nem fogadnak foglalást, munkatársai nem végezhetnek módosítást. Adatait a 12. pont szerint őrizzük meg.",
      ],
    },
    {
      id: "data",
      heading: "8. Az Előfizető és ügyfelei adatai",
      blocks: [
        "Az Előfizető ügyfeleinek személyes adatai (név, elérhetőség, foglalások, üzenetek) tekintetében az Előfizető az adatkezelő, a Szolgáltató az adatfeldolgozó. Az Adatkezelési tájékoztató 4. pontjában foglalt adatfeldolgozási feltételek jelen ÁSZF részét képezik.",
        "Az Előfizető felel azért, hogy az általa gyűjtött adatok kezelésére megfelelő jogalappal rendelkezzen, ügyfeleit tájékoztassa, és ne adjon meg több adatot, mint amennyit a foglalások megkívánnak.",
      ],
    },
    {
      id: "acceptable-use",
      heading: "9. Rendeltetésszerű használat",
      blocks: [
        "A Szolgáltatás nem használható jogellenes célra, kéretlen üzenetek küldésére, félrevezető információ közzétételére, más szervezetek adataihoz való hozzáférés kísérletére vagy a Szolgáltatás túlterhelésére.",
      ],
    },
    {
      id: "availability",
      heading: "10. Rendelkezésre állás",
      blocks: [
        "Törekszünk a Szolgáltatás folyamatos elérhetőségére, azt folyamatosan felügyeljük, adatairól 30 percenként titkosított, külső helyszínen tárolt mentés készül. A megszakítás nélküli működést nem garantáljuk. A tervezett karbantartásról lehetőség szerint előre, e-mailben értesítünk.",
      ],
    },
    {
      id: "liability",
      heading: "11. Felelősség",
      blocks: [
        "A jogszabályok által megengedett mértékben a Szolgáltatással összefüggő károkért való felelősségünk a kárt okozó eseményt megelőző három hónapban az Előfizető által megfizetett díj összegére korlátozódik. E korlátozás nem vonatkozik a szándékosan vagy súlyos gondatlansággal okozott, valamint az életet, testi épséget vagy egészséget megkárosító szerződésszegésre.",
        "Nem felelünk az Előfizető által közzétett tartalomért, az MI-asszisztens válaszai alapján hozott döntésekért, sem az észszerű befolyásunkon kívül eső események okozta kiesésekért.",
      ],
    },
    {
      id: "termination",
      heading: "12. A szerződés megszűnése",
      blocks: [
        "A szerződés megszűnik a lemondás hatálybalépésével, az előfizetés díjnemfizetés miatti megszűnésével, vagy ha azt a Szolgáltató jelen ÁSZF súlyos megszegése miatt, e-mailes értesítés után felmondja.",
        "A megszűnést követő 30 napon belül az Előfizető e-mailben kérheti ügyfelei adatainak géppel olvasható formátumú másolatát. Ezt követően a szervezet adatait töröljük. A számlákat a számviteli jogszabályok által előírt ideig megőrizzük, a mentések 37 napon belül lejárnak.",
      ],
    },
    {
      id: "amendments",
      heading: "13. Az ÁSZF módosítása",
      blocks: [
        "Az ÁSZF módosításáról az Előfizetőket legalább 15 nappal a hatálybalépés előtt e-mailben értesítjük. Aki a módosítást nem fogadja el, addig lemondhatja az előfizetését; az időpont utáni további használat elfogadásnak minősül.",
      ],
    },
    {
      id: "law",
      heading: "14. Irányadó jog",
      blocks: [
        "Jelen ÁSZF-re a magyar jog az irányadó. A jogviták eldöntésére a hatáskörrel és illetékességgel rendelkező magyar bíróság jogosult.",
      ],
    },
    {
      id: "contact",
      heading: "15. Kapcsolat",
      blocks: [
        "Az ÁSZF-fel kapcsolatos kérdéseket az alábbi impresszumban szereplő e-mail-címre várjuk.",
      ],
    },
  ],
};
