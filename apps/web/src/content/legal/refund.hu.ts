import type { LegalDocument } from "./types";

export const refundHu: LegalDocument = {
  title: "Lemondás és visszatérítés",
  effective: "2026-11-01",
  intro: [
    "Ez az oldal leírja, hogyan mondható le a Booking and More előfizetés, és mikor jár visszatérítés. Az ÁSZF részét képezi.",
  ],
  sections: [
    {
      id: "cancel",
      heading: "1. Lemondás",
      blocks: [
        "A tulajdonos bármikor lemondhatja az előfizetést az irányítópulton: Előfizetés, majd Számlázás kezelése. A lemondás a kifizetett időszak végén lép hatályba. A Szolgáltatás addig elérhető marad, további terhelés nem történik.",
      ],
    },
    {
      id: "trial",
      heading: "2. Az ingyenes próbaidőszak alatt",
      blocks: [
        "Ha az előfizetést a próbaidőszak vége előtt lemondják, semmilyen terhelés nem történik.",
      ],
    },
    {
      id: "refunds",
      heading: "3. Visszatérítés",
      blocks: [
        "A havidíjnak a lemondás vagy az alacsonyabb csomagra váltás után hátralévő időszakra eső részét nem térítjük vissza. Visszatérítjük:",
        {
          list: [
            "a tévesen terhelt összeget, például a kétszeres terhelést vagy a lemondás hatálybalépése utáni terhelést, teljes egészében;",
            "kérésre a havidíj időarányos részét, ha a Szolgáltatás az időszak jelentős részében a mi érdekkörünkbe tartozó okból nem volt elérhető;",
            "minden más esetben, ha jogszabály előírja.",
          ],
        },
      ],
    },
    {
      id: "how",
      heading: "4. A visszatérítés kérése",
      blocks: [
        "A terheléstől számított 30 napon belül írjon az alábbi impresszumban szereplő e-mail-címre, megnevezve a szervezetet és a számlát. A jóváhagyott visszatérítést a Stripe-on keresztül a fizetésre használt kártyára utaljuk vissza; a bankok általában 5–10 munkanapon belül jóváírják. A visszatérítésről helyesbítő számlát állítunk ki.",
      ],
    },
    {
      id: "plan-changes",
      heading: "5. Csomagváltás",
      blocks: [
        "A magasabb csomagra váltáskor a különbözetet az időszak hátralévő részére időarányosan terheljük. Az alacsonyabb csomagra váltás az időszak végén lép hatályba, a különbözetet nem térítjük vissza.",
      ],
    },
    {
      id: "assisted-setup",
      heading: "6. Támogatott beállítás",
      blocks: [
        "Az egyszeri beállítási díjat teljes egészében visszatérítjük, ha a megrendelést a munka megkezdése előtt lemondják. A beállítás elvégzése után nem jár visszatérítés.",
      ],
    },
    {
      id: "consumers",
      heading: "7. Elállási jog",
      blocks: [
        "A Szolgáltatást kizárólag vállalkozások részére nyújtjuk, ezért a fogyasztót a 45/2014. (II. 26.) Korm. rendelet alapján megillető elállási jog nem alkalmazandó.",
      ],
    },
  ],
};
