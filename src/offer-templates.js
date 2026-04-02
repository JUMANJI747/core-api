// HTML offer templates per language
// Images hosted on surfstickbell.com, identical structure per language

const CSS = `<style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #222; padding: 10px; }
    h2, h3 { color: #1a73e8; }
    p, ul { text-align: left; }
    ul { margin-left: 20px; }
    .row { display: flex; flex-wrap: wrap; justify-content: flex-start; gap: 20px; margin: 20px 0; }
    .row img { border-radius: 6px; vertical-align: top; object-fit: contain; height: 220px; width: auto; max-width: 180px; }
    a { color: #1a73e8; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>`;

const IMAGES = {
  hero: 'https://surfstickbell.com/wp-content/uploads/2025/10/zdjecie1.jpg',
  row: [
    'https://surfstickbell.com/wp-content/uploads/2025/10/zdjecie2.jpg',
    'https://surfstickbell.com/wp-content/uploads/2025/10/zdjecie3.jpg',
    'https://surfstickbell.com/wp-content/uploads/2025/10/zdjecie4-scaled.jpg',
  ],
};

const FOOTER = `<strong>Surf Stick Bell</strong><br>
WhatsApp : +34 624 46 48 33<br>
<a href="mailto:info@surfstickbell.com">info@surfstickbell.com</a><br>
Instagram : @surfstickbell`;

function buildTemplate(lang, texts) {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${CSS}
</head>
<body>

<p>${texts.greeting},</p>

<p>
${texts.intro}
</p>

<p>
${texts.natural}
</p>

<p>
${texts.orders}
</p>

<p>
${texts.season}
</p>

<div class="row">
  <img src="${IMAGES.hero}" alt="Surf Stick SPF 50+">
</div>

<h3>${texts.productsTitle}</h3>

<ul>
  <li><strong>Surf Stick SPF 50+</strong> – ${texts.stickDesc}</li>
  <li><strong>Surf Gel SPF 50</strong> – ${texts.gelDesc}</li>
  <li><strong>Surf Daily SPF 50</strong> – ${texts.dailyDesc}</li>
  <li><strong>Surf Care</strong> – ${texts.careDesc}</li>
  <li><strong>Surf Girl Mascara</strong> – ${texts.mascaraDesc}</li>
</ul>

<div class="row">
  <img src="${IMAGES.row[0]}" alt="Surf Daily SPF 50">
  <img src="${IMAGES.row[1]}" alt="Surf Lips / Care">
  <img src="${IMAGES.row[2]}" alt="Surf Collection Display">
</div>

<h3>${texts.pricingTitle}</h3>

<p><strong>${texts.pricingIntro}</strong></p>

<ul>
  <li><strong>${texts.wholesale}:</strong> 4,50 EUR / ${texts.unit}</li>
  <li><strong>${texts.retail}:</strong> 9 EUR (${texts.inclTax})</li>
  <li><strong>${texts.minOrder}:</strong> 30 ${texts.units} (${texts.combinable})</li>
  <li><strong>${texts.delivery}:</strong> ${texts.freeFrom30}</li>
  <li><strong>${texts.payment}:</strong> ${texts.bankTransfer}</li>
  <li><strong>${texts.displays}:</strong> ${texts.free}</li>
</ul>

<p><em>${texts.pdfNote}</em></p>

<p>
${texts.cta}
</p>

<p>
${texts.closing},<br>
${FOOTER}
</p>

</body>
</html>`;
}

const FR = buildTemplate('fr', {
  greeting: 'Bonjour',
  intro: 'Nous vous présentons la <strong>Surf Collection SPF 50</strong>, notre gamme de protection solaire conçue pour les surfeurs, les sports nautiques et les activités en plein air.\nLes formules sont résistantes à l\'eau et à la transpiration, ne fondent pas à la chaleur et n\'irritent pas les yeux.',
  natural: 'Selon le produit, elles contiennent jusqu\'à <strong>100 % d\'ingrédients naturels</strong>, toutes les formules sont <strong>véganes</strong> et <strong>respectueuses des récifs coralliens</strong>.',
  orders: 'Nous acceptons d\'ores et déjà les <strong>commandes pour la saison 2026</strong>, avec des <strong>prix inchangés</strong>.\n<strong>Nous effectuons déjà les livraisons des commandes d\'été</strong>, avec une disponibilité garantie.',
  season: 'Les commandes peuvent également être passées en cours de saison.\nLors de votre commande, merci d\'indiquer votre <strong>date de livraison souhaitée</strong>.',
  productsTitle: 'Produits disponibles',
  stickDesc: 'Stick visage SPF50+ résistant à l\'eau et teinté, à base d\'oxyde de zinc (la couleur blanche est 100 % naturelle).',
  gelDesc: 'Gel technique transparent SPF50+, ultra résistant à l\'eau, ne pique pas les yeux, idéal pour les sports nautiques et les activités intenses en extérieur.',
  dailyDesc: 'Crème légère SPF 50 à l\'acide hyaluronique, parfaite pour un usage quotidien.',
  careDesc: 'Baume apaisant et hydratant après-soleil et après-surf, contient de l\'aloe vera et du panthénol.',
  mascaraDesc: 'Mascara longue tenue, coloré et résistant à l\'eau.',
  pricingTitle: 'Tarifs',
  pricingIntro: 'Tous nos produits sont proposés au même prix :',
  wholesale: 'Prix de gros', retail: 'Prix de vente conseillé', minOrder: 'Commande minimum',
  delivery: 'Livraison', payment: 'Paiement', displays: 'Présentoirs de démonstration',
  unit: 'unité', units: 'unités', inclTax: 'TTC', combinable: 'produits combinables',
  freeFrom30: 'gratuite à partir de 30 unités', bankTransfer: 'virement bancaire', free: 'gratuits',
  pdfNote: 'Vous trouverez en pièce jointe un fichier PDF avec des informations complémentaires.',
  cta: 'Si vous souhaitez <strong>réserver du stock pour 2026</strong> ou si vous avez des questions, n\'hésitez pas à répondre à cet e-mail ou à nous contacter par WhatsApp.',
  closing: 'Cordialement',
});

const PT = buildTemplate('pt', {
  greeting: 'Bom dia',
  intro: 'Apresentamos a <strong>Surf Collection SPF 50</strong>, a nossa gama de proteção solar concebida para surfistas, desportos aquáticos e atividades ao ar livre.\nAs fórmulas são resistentes à água e ao suor, não derretem com o calor e não irritam os olhos.',
  natural: 'Dependendo do produto, contêm até <strong>100% de ingredientes naturais</strong>, todas as fórmulas são <strong>veganas</strong> e <strong>amigas dos recifes de coral</strong>.',
  orders: 'Já estamos a aceitar <strong>encomendas para a temporada 2026</strong>, com <strong>preços inalterados</strong>.\n<strong>Já estamos a efetuar entregas de encomendas de verão</strong>, com disponibilidade garantida.',
  season: 'As encomendas também podem ser feitas durante a temporada.\nAo encomendar, por favor indique a sua <strong>data de entrega pretendida</strong>.',
  productsTitle: 'Produtos disponíveis',
  stickDesc: 'Stick facial SPF50+ resistente à água e com cor, à base de óxido de zinco (a cor branca é 100% natural).',
  gelDesc: 'Gel técnico transparente SPF50+, ultra resistente à água, não irrita os olhos, ideal para desportos aquáticos e atividades intensas ao ar livre.',
  dailyDesc: 'Creme leve SPF 50 com ácido hialurónico, perfeito para uso diário.',
  careDesc: 'Bálsamo calmante e hidratante pós-sol e pós-surf, contém aloe vera e pantenol.',
  mascaraDesc: 'Máscara de longa duração, colorida e resistente à água.',
  pricingTitle: 'Preços',
  pricingIntro: 'Todos os nossos produtos têm o mesmo preço:',
  wholesale: 'Preço por grosso', retail: 'Preço de venda recomendado', minOrder: 'Encomenda mínima',
  delivery: 'Entrega', payment: 'Pagamento', displays: 'Expositores de demonstração',
  unit: 'unidade', units: 'unidades', inclTax: 'IVA incl.', combinable: 'produtos combináveis',
  freeFrom30: 'gratuita a partir de 30 unidades', bankTransfer: 'transferência bancária', free: 'gratuitos',
  pdfNote: 'Em anexo encontra um ficheiro PDF com informações complementares.',
  cta: 'Se pretende <strong>reservar stock para 2026</strong> ou se tem alguma questão, não hesite em responder a este e-mail ou contactar-nos por WhatsApp.',
  closing: 'Cumprimentos',
});

const ES = buildTemplate('es', {
  greeting: 'Buenos días',
  intro: 'Le presentamos la <strong>Surf Collection SPF 50</strong>, nuestra gama de protección solar diseñada para surfistas, deportes acuáticos y actividades al aire libre.\nLas fórmulas son resistentes al agua y al sudor, no se derriten con el calor y no irritan los ojos.',
  natural: 'Según el producto, contienen hasta <strong>100% de ingredientes naturales</strong>, todas las fórmulas son <strong>veganas</strong> y <strong>respetuosas con los arrecifes de coral</strong>.',
  orders: 'Ya estamos aceptando <strong>pedidos para la temporada 2026</strong>, con <strong>precios sin cambios</strong>.\n<strong>Ya estamos realizando entregas de pedidos de verano</strong>, con disponibilidad garantizada.',
  season: 'Los pedidos también se pueden realizar durante la temporada.\nAl realizar su pedido, por favor indique su <strong>fecha de entrega deseada</strong>.',
  productsTitle: 'Productos disponibles',
  stickDesc: 'Stick facial SPF50+ resistente al agua y con color, a base de óxido de zinc (el color blanco es 100% natural).',
  gelDesc: 'Gel técnico transparente SPF50+, ultra resistente al agua, no irrita los ojos, ideal para deportes acuáticos y actividades intensas al aire libre.',
  dailyDesc: 'Crema ligera SPF 50 con ácido hialurónico, perfecta para uso diario.',
  careDesc: 'Bálsamo calmante e hidratante post-solar y post-surf, contiene aloe vera y pantenol.',
  mascaraDesc: 'Máscara de larga duración, colorida y resistente al agua.',
  pricingTitle: 'Precios',
  pricingIntro: 'Todos nuestros productos tienen el mismo precio:',
  wholesale: 'Precio mayorista', retail: 'Precio de venta recomendado', minOrder: 'Pedido mínimo',
  delivery: 'Envío', payment: 'Pago', displays: 'Expositores de demostración',
  unit: 'unidad', units: 'unidades', inclTax: 'IVA incl.', combinable: 'productos combinables',
  freeFrom30: 'gratuito a partir de 30 unidades', bankTransfer: 'transferencia bancaria', free: 'gratuitos',
  pdfNote: 'Adjunto encontrará un archivo PDF con información complementaria.',
  cta: 'Si desea <strong>reservar stock para 2026</strong> o si tiene alguna pregunta, no dude en responder a este correo o contactarnos por WhatsApp.',
  closing: 'Saludos cordiales',
});

const EN = buildTemplate('en', {
  greeting: 'Hello',
  intro: 'We present the <strong>Surf Collection SPF 50</strong>, our sun protection range designed for surfers, water sports and outdoor activities.\nThe formulas are resistant to water and sweat, don\'t melt in heat and don\'t sting the eyes.',
  natural: 'Depending on the product, they contain up to <strong>100% natural ingredients</strong>, all formulas are <strong>vegan</strong> and <strong>reef-friendly</strong>.',
  orders: 'We are already accepting <strong>orders for the 2026 season</strong>, with <strong>unchanged prices</strong>.\n<strong>We are already delivering summer orders</strong>, with guaranteed availability.',
  season: 'Orders can also be placed during the season.\nWhen ordering, please indicate your <strong>preferred delivery date</strong>.',
  productsTitle: 'Available products',
  stickDesc: 'Face stick SPF50+ water-resistant and tinted, based on zinc oxide (white colour is 100% natural).',
  gelDesc: 'Transparent technical gel SPF50+, ultra water-resistant, doesn\'t sting the eyes, ideal for water sports and intense outdoor activities.',
  dailyDesc: 'Lightweight SPF 50 cream with hyaluronic acid, perfect for daily use.',
  careDesc: 'Soothing and moisturising after-sun and after-surf balm, contains aloe vera and panthenol.',
  mascaraDesc: 'Long-lasting, coloured and waterproof mascara.',
  pricingTitle: 'Pricing',
  pricingIntro: 'All our products are offered at the same price:',
  wholesale: 'Wholesale price', retail: 'Recommended retail price', minOrder: 'Minimum order',
  delivery: 'Delivery', payment: 'Payment', displays: 'Display stands',
  unit: 'unit', units: 'units', inclTax: 'incl. tax', combinable: 'products can be combined',
  freeFrom30: 'free from 30 units', bankTransfer: 'bank transfer', free: 'free',
  pdfNote: 'Please find attached a PDF file with additional information.',
  cta: 'If you would like to <strong>reserve stock for 2026</strong> or if you have any questions, feel free to reply to this email or contact us via WhatsApp.',
  closing: 'Best regards',
});

const PL = buildTemplate('pl', {
  greeting: 'Dzień dobry',
  intro: 'Przedstawiamy <strong>Surf Collection SPF 50</strong>, naszą gamę ochrony przeciwsłonecznej stworzoną dla surferów, sportów wodnych i aktywności na świeżym powietrzu.\nFormuły są odporne na wodę i pot, nie topią się w upale i nie szczypią w oczy.',
  natural: 'W zależności od produktu zawierają do <strong>100% naturalnych składników</strong>, wszystkie formuły są <strong>wegańskie</strong> i <strong>przyjazne dla raf koralowych</strong>.',
  orders: 'Już przyjmujemy <strong>zamówienia na sezon 2026</strong>, w <strong>niezmiennych cenach</strong>.\n<strong>Już realizujemy dostawy zamówień letnich</strong>, z gwarantowaną dostępnością.',
  season: 'Zamówienia można składać również w trakcie sezonu.\nPrzy zamówieniu prosimy o podanie <strong>preferowanej daty dostawy</strong>.',
  productsTitle: 'Dostępne produkty',
  stickDesc: 'Sztyft do twarzy SPF50+ wodoodporny i kolorowy, na bazie tlenku cynku (biały kolor jest w 100% naturalny).',
  gelDesc: 'Przezroczysty żel techniczny SPF50+, ultra wodoodporny, nie szczypie w oczy, idealny do sportów wodnych i intensywnych aktywności na świeżym powietrzu.',
  dailyDesc: 'Lekki krem SPF 50 z kwasem hialuronowym, idealny do codziennego użytku.',
  careDesc: 'Kojący i nawilżający balsam po opalaniu i po surfingu, zawiera aloe vera i pantenol.',
  mascaraDesc: 'Trwały, kolorowy i wodoodporny tusz do rzęs.',
  pricingTitle: 'Cennik',
  pricingIntro: 'Wszystkie nasze produkty mają tę samą cenę:',
  wholesale: 'Cena hurtowa', retail: 'Sugerowana cena detaliczna', minOrder: 'Minimalne zamówienie',
  delivery: 'Dostawa', payment: 'Płatność', displays: 'Ekspozytory',
  unit: 'sztuka', units: 'sztuk', inclTax: 'brutto', combinable: 'produkty można łączyć',
  freeFrom30: 'gratis od 30 sztuk', bankTransfer: 'przelew bankowy', free: 'gratis',
  pdfNote: 'W załączniku znajdziesz plik PDF z dodatkowymi informacjami.',
  cta: 'Jeśli chcesz <strong>zarezerwować towar na 2026</strong> lub masz pytania, napisz do nas odpowiadając na tego maila lub skontaktuj się przez WhatsApp.',
  closing: 'Pozdrawiam',
});

const OFFER_TEMPLATES = { FR, PT, ES, EN, PL };

module.exports = { OFFER_TEMPLATES };
