import { camposIaPara } from '@/lib/campos'
import { JURISDICCIONES_IIBB } from '@/lib/percepcionIibb'
import { TIPOS_FACTURA, analizaCampo, type TipoFactura } from '@/lib/tipoFactura'

/**
 * Numera las reglas al armar el prompt en vez de tener el número escrito a
 * mano en cada una. Cada tipo de comprobante inserta su propia regla en el
 * medio de la lista, así que los números no coinciden entre tipos; con los
 * números escritos a mano habría que renumerar tres bloques cada vez que
 * se agrega una regla, y una lista salteada o repetida es exactamente el
 * tipo de ruido que le hace perder precisión al modelo.
 */
function numerar(reglas: string[]): string[] {
  return reglas.map((regla, i) => {
    const [primera, ...resto] = regla.split('\n')
    return [`${i + 1}. ${primera}`, ...resto.map((l) => `   ${l}`)].join('\n')
  })
}

const LECTURA_LITERAL = `Devolvé el valor EXACTAMENTE como figura en el PDF. No normalices, no
conviertas, no reformatees. Si el importe dice "322.982,28", devolvé
"322.982,28" y no "322982.28". Si el CUIT tiene guiones, dejale los guiones.
Esto es especialmente estricto con los importes: copiá los separadores
tal como están impresos, aunque distintos importes del mismo comprobante
usen formatos distintos -- pasa.`

const CAMPO_AUSENTE = `Si un campo no figura en el comprobante, devolvé valor como cadena vacía
("") y confianza 0. No lo infieras, no lo calcules a partir de otros
campos, no lo inventes.`

const CONFIANZA = `La confianza va de 0 a 1 y expresa qué tan seguro estás de haber leído bien
ese dato puntual en este PDF puntual. Un campo impreso con nitidez y sin
ambigüedad va cerca de 1. Un campo borroso, cortado, escrito a mano o que
podría confundirse con otro va abajo de 0,8. Sé honesto: una confianza alta
sobre un dato que leíste mal le cuesta plata al operador, porque es
exactamente el campo que va a revisar menos.`

const PUNTO_VENTA = `El punto de venta y el número van por separado y sin el prefijo del tipo.
De "FACTURA A 0011-00063576" sale ptovta "0011" y nro "00063576".`

/**
 * La regla que faltaba: el comprobante tiene dos partes con razon social y
 * CUIT -- quien emite y quien recibe -- y el catalogo listaba "razon" y
 * "cuit" sin decir cual. El modelo elegia, y en una factura real cargo el
 * cliente. Se le nombra el CUIT propio para que tenga como descartarlo.
 */
function quienEsElProveedor(cuitPropio: string | null, tipo: TipoFactura): string {
  // `condiva` no se pide en todos los tipos: nombrarlo cuando no esta en la
  // lista de campos manda al modelo a buscar un dato que despues no puede
  // devolver.
  const cuales = analizaCampo(tipo, 'condiva') ? 'razon, cuit y condiva' : 'razon y cuit'
  const base = `${cuales} son SIEMPRE del EMISOR del comprobante: el
proveedor que nos vende. Nunca del receptor.

El emisor es el que figura arriba, con el logo y el membrete. El receptor
aparece mas abajo, en un bloque que suele decir "Cliente", "Señor(es)",
"Razon social" o "Facturado a". Ese bloque es nuestra propia empresa: sus
datos NO van en ningun campo.

Si dudas, el emisor es el que tiene el punto de venta y el CAE del
comprobante; el receptor solo tiene nombre, domicilio y CUIT.`

  if (!cuitPropio) return base

  return `${base}

Nuestro CUIT es ${cuitPropio}. Si lo ves en el comprobante, es el del
receptor: no lo devuelvas nunca en cuit.`
}

const IVA_Y_PERCEPCIONES = `Distinguí el neto gravado de los impuestos y de las percepciones. Las
percepciones de IVA y de ingresos brutos suelen figurar al pie, separadas
del IVA propiamente dicho.`

const SLOTS_IVA = `El comprobante puede tener más de una alícuota de IVA, o mezclar
alícuotas con percepciones de IVA -- por ejemplo "21% + percepción de
IVA". Para eso hay cinco pares porcivaN/impivaN. Usalos en orden desde
el 1, uno por cada alícuota, percepción o retención de IVA que encuentres
en el comprobante, sin dejar huecos; los pares que sobren quedan vacíos.

En cada par, impivaN es el IMPORTE de esa línea -- no la base imponible
sobre la que se calculó -- y porcivaN es una de dos cosas:
- el PORCENTAJE, si la línea lo imprime ("21", "10,5");
- el RÓTULO tal como figura, si no lo imprime ("Retención IVA", "IVA
  S/ARANCEL + COSTO FINANCIERO", "Percep./Retenc. AFIP - DGI").
Sin el porcentaje, el rótulo es lo único que dice a qué alícuota va esa
línea, y la app lo aprende por proveedor. Nunca inventes un porcentaje
para completar el campo, y nunca pongas "0": el cero es una alícuota real
de tasa cero y le dice a la app que no registre la línea.

neto es el neto gravado TOTAL del comprobante: si hay más de una base
imponible, sumalas todas ahí, no las repartas entre los pares.

Una percepción de IVA ocupa un par como cualquier alícuota; las
percepciones de ingresos brutos y los demás impuestos van aparte, en sus
propios pares (ver más abajo).

Una percepción o retención de IVA va SIEMPRE en un par porcivaN/impivaN,
nunca en variosN. Es de IVA toda línea que mencione IVA, la AFIP o la DGI,
o el número de un régimen de IVA: "Percepción IVA", "Perc. IVA RG 2408",
"Percepción R.G. 3337", "Percep./Retenc. AFIP - DGI", "Retención Iva
Resolución General Nº 140".

Ojo con dos que se le parecen y NO son de IVA: las de Ingresos Brutos
(van en percepN, aunque digan AFIP) y el impuesto sobre los débitos y
créditos.`

/**
 * Que va en `percepN`.
 *
 * Hasta el 2026-09-11 se le pedia al modelo la JURISDICCION normalizada --
 * "Tucuman", "Bancarias"-- en vez del texto de la linea. El usuario lo
 * reporto sobre una liquidacion de Valle Fertil cuyo renglon dice "Retencion
 * Ingresos Brutos" y la pantalla mostraba "Bancarias": una etiqueta que no
 * esta en el comprobante y que el operador no tiene contra que cotejar.
 *
 * Ahora va el rotulo tal cual. La resolucion no cambia: `resolverPercepcionIibb`
 * busca los alias DENTRO del texto, asi que "Perc. IIBB Tucuman RG 22/18"
 * sigue resolviendo al 60 igual que resolvia "Tucuman". Y lo aprendido por
 * proveedor pasa a tener como clave el rotulo impreso, que es la misma clave
 * con la que el usuario armo su tabla de imputacion.
 */
const PERCEPCIONES = [
  `Las líneas de Ingresos Brutos van en los cuatro pares
percepN/imppercepN, en orden desde el 1 y sin dejar huecos. En cada par,
percepN es el RÓTULO de esa línea tal como está impreso e imppercepN es su
importe.

Copiá el rótulo como figura, sin normalizarlo, sin traducirlo y sin
reemplazarlo por el nombre de la provincia: de "Retención Ingresos
Brutos ... 6.030,58" sale percep1 "Retención Ingresos Brutos", y de
"Ret.IB TUCUMAN 5,00 % ... 7.748,86" sale percep1 "Ret.IB TUCUMAN 5,00 %".
El operador coteja ese texto contra el papel, así que tiene que decir lo
mismo que el papel. A qué código de Tango va lo resuelve la app.

Sacá del rótulo el importe y los puntos de relleno, nada más. El porcentaje
que venga en el texto dejalo: es parte del rótulo.

Qué cuenta como línea de Ingresos Brutos, que es lo que decide que vaya acá
y no en variosN:`,
  ...JURISDICCIONES_IIBB.map((j) => `- ${j.criterio}.`),
  `Si la línea es de una jurisdicción que no está en esa lista (Córdoba,
Santa Fe y demás), va acá igual, con su rótulo: el operador la va a ver
marcada como no reconocida y decide qué hacer.`,
].join('\n')

/**
 * El único campo que no sale del texto impreso. Los comprobantes llegan
 * escaneados y muchos vienen anotados a mano por quien hizo la compra --
 * típicamente la identificación del vehículo en un ticket de combustible --
 * y eso es justo lo que el operador venía copiando a mano en la observación.
 *
 * Se pide corto y literal, sin interpretar: es la referencia interna de la
 * empresa, no un dato del comprobante, y va a una columna de 30 caracteres
 * (`CPA04.LEYENDA`).
 */
const MANUSCRITO = `El comprobante puede venir con algo ESCRITO A MANO encima: los tickets
suelen llegar anotados con birome por quien hizo la compra. Transcribí esa
anotación en leyendaAsiento, tal cual está escrita y en una sola línea (por
ejemplo "DFSK - Log. - TC ICBC"). Es una referencia interna de la empresa
--qué vehículo, qué sector, con qué tarjeta se pagó-- así que no la
interpretes, no la completes y no la traduzcas: copiala.

Si hay varias anotaciones sueltas, unilas con " - " en el orden en que
aparecen. Si la anotación no se entiende, transcribí lo que puedas leer y
bajá la confianza; si no hay nada escrito a mano, dejá leyendaAsiento vacío
-- no pongas ahí nada del texto impreso.

No cuentan como anotación a mano: las marcas de resaltador, los tildes,
subrayados o círculos sobre datos que ya están impresos, ni las firmas.
Tampoco los sellos. Solo el texto agregado a mano.`

const IMPUESTOS_VARIOS = `Todo impuesto que no sea IVA -- ni alícuota ni
percepción de IVA -- ni Ingresos Brutos: impuesto interno, impuesto a las
ganancias, retenciones municipales, impuesto sobre los débitos y créditos,
tributos de emergencia y similares. Van en los dos pares
variosN/impvariosN. impvariosN es el importe de esa línea, y variosN el
NOMBRE del impuesto tal como está impreso ("Trib. emerg. munic.",
"Retención TEM", "Impuesto a las ganancias"), no un código: el código de
Tango lo resuelve el sistema, igual que con las percepciones de Ingresos
Brutos. Copiá el rótulo como figura, sin traducirlo ni abreviarlo.`

/**
 * Lo que cambia entre tipos: qué es el comprobante, qué hacer con los
 * renglones, y dónde poner la atención. El operador ya eligió el tipo al
 * importar, así que acá se afirma, no se pregunta.
 */
const SEGUN_TIPO: Record<TipoFactura, string> = {
  conceptos: `Este comprobante es una FACTURA DE CONCEPTOS: un servicio o un gasto
(telefonía, luz, gas, agua, internet, seguros, alquiler, honorarios,
fletes, publicidad, gastos bancarios y similares), no mercadería para la
venta.
No se te pide el detalle de sub-ítems que pueda traer -- líneas
telefónicas, planes, consumos, períodos facturados -- ni tampoco el CAE,
la orden de compra, la moneda ni la condición de pago. Nada de eso se
imputa, y no vas a encontrar esos campos en la lista de abajo.
Poné la atención en el neto gravado, las alícuotas de IVA y las
percepciones del pie: son los únicos datos que se imputan.`,

  articulos: `Este comprobante es una FACTURA DE ARTÍCULOS: una compra de mercadería
con detalle de renglones.
Transcribí ese detalle en el array "renglones_pdf": una entrada por cada
artículo que la factura cobra, con cuatro datos tal como están impresos:
- "codigo": el CÓDIGO del artículo, y SOLO el código. Es el que imprime el
  proveedor: a veces es el mismo que usamos nosotros y a veces es el suyo
  propio; copiá el que figure, sin traducirlo. Si en la misma celda hay
  además una alícuota de IVA entre paréntesis, un asterisco o una nota
  ("AS-12UW4RLRCD02 N ( 21.00) *"), el código es solo la primera parte
  ("AS-12UW4RLRCD02 N"): no incluyas lo demás. Si el renglón no trae
  código, dejalo vacío.
  EXCEPCIÓN IMPORTANTE: si el renglón tiene una COLUMNA APARTE con el
  color, la variante o el artículo-color -- encabezados como "Color",
  "Col.", "Cod.Color" o una segunda columna de números pegada al código --,
  ese valor ES PARTE DEL CÓDIGO y va incluido, separado por un espacio:
  "1261095 140", "167686 001". No es una nota ni un comentario: el mismo
  artículo en otro color es otro artículo, con otro código, y sin ese dato
  el renglón no se puede identificar. Poné primero el código y después el
  color, en el orden en que están impresos.
- "descripcion": la DESCRIPCIÓN del artículo tal como está impresa, entera.
  Es lo que identifica al artículo cuando la factura no trae código.
  ATENCIÓN CON LOS TALLES. En indumentaria y calzado es común que el
  renglón esté partido en dos líneas: arriba el código y la descripción, y
  abajo el desglose de cuántas unidades van de cada talle, del estilo
  "L : 6  M : 4  S : 2  XL : 4" o "270: 4  310: 6  320: 6", con la cantidad
  total, el precio y la bonificación a la derecha. Las dos líneas son UN
  SOLO renglón: copiá ese desglose al final de la descripción, tal como
  está impreso, con sus dos puntos. Cada talle es un artículo distinto para
  nosotros y sin el desglose no se puede saber cuántos van de cada uno. La
  cantidad de la línea sigue siendo el TOTAL impreso, no la de un talle.
- "cantidad": la CANTIDAD facturada.
- "precioUnitario": el PRECIO UNITARIO tal como está impreso, aunque sea el
  de lista antes de un descuento. No lo recalcules.
- "subtotal": el IMPORTE del renglón tal como está impreso (la columna
  "Subtotal", "Importe", "Total" del renglón). No lo recalcules: si
  cantidad × precio no da el subtotal, copiá igual lo que dice el papel --
  el sistema resuelve el descuento después.
No metas en ese array los totales, subtotales generales, descuentos ni las
líneas de impuestos del pie: solo la mercadería.
Si el pie trae un DESCUENTO GLOBAL sobre toda la compra -- "Descuento
General", "Descuento", "Bonificación", "Dto. global" o similar, como
importe --, ponelo en descuentogeneral, en positivo. Si no hay, dejalo
vacío. No lo restes vos de ningún otro campo.
También buscá la CONDICIÓN DE PAGO O DE VENTA, con etiquetas como
"Condición de Venta", "Condiciones de Pago", "Forma de Pago" o similar.
Devolvela tal como está impresa en condpago -- "Cuenta Corriente", "D026",
"30-60-90 días", lo que figure, sin interpretarla ni convertirla a un
código de Tango: eso lo hace el sistema después, comparándola contra lo
que ya aprendió de este proveedor.
Poné la atención en eso, en el neto gravado, las alícuotas de IVA y las
percepciones del pie.`,

  tarjeta: `Este comprobante es una LIQUIDACIÓN DE TARJETA o un resumen bancario
(VISA, Mastercard, Naranja, American Express, o un banco).
No se te pide el detalle de cupones, cuotas ni consumos: no se carga en
Tango y no vas a encontrar campos de renglón en la lista de abajo. Todo el
comprobante se imputa a un solo concepto -- comisiones de tarjeta -- así
que lo único que importa son los datos de cabecera, el subtotal y los
impuestos.
El NÚMERO casi nunca viene como en una factura común. Acá suele figurar
como número de liquidación, con etiquetas tipo "Nro. Liquidación",
"Liquidación Nº", "Nro. Liquidacion" o "Número de liquidación": ese es el
que va en nro, tal como está impreso.
Cuidado con dos trampas de estos documentos:
- Una etiqueta que dice "comprobante" y no trae ningún número. "Comprobante
  a Liquidar" suele traer el nombre de un plan ("PLAN SI 3X1"): eso no va
  en ningún campo.
- Los demás números que trae la liquidación -- código de comercio, número
  de cupón, de autorización, de tarjeta o de operación -- no son el número
  del comprobante.
Estas liquidaciones tampoco suelen imprimir la letra (A/B/C) ni el punto de
venta. Si no los ves, dejá tipo y ptovta vacíos y no los deduzcas de otro
número del documento: el operador los completa.
EL NETO GRAVADO ES EL DATO MÁS DIFÍCIL DE ESTE COMPROBANTE. Leelo con más
cuidado que ningún otro, porque casi nunca viene impreso en un renglón
propio: es la SUMA de todos los cargos que la procesadora nos cobra, y hay
que armarla sumando línea por línea.
Los cargos que suman al neto gravado aparecen con rótulos como "Arancel",
"Arancel de ley", "Comisión", "Costo financiero", "Serv. Costos
Financieros", "Cargo transferencia", "Pago Express", "Promociones",
"Descuento por cuotas" o "Plan cuotas". No todos aparecen en todos los
resúmenes, y cada procesadora los rotula distinto: sumá los que estén.
NO confundas el neto gravado con ninguna de estas, que son las que más
inducen al error:
- El bruto de las ventas presentadas: "Importe Bruto", "Monto presentado",
  "TOTAL PRESENTADO", "Monto Presentado". Es lo que vendimos, no lo que nos
  cobran.
- Lo que se acredita: "Importe neto", "SALDO", "Neto percibido",
  "Acreditado en cuenta", "Total a acreditar". Ojo que a veces se llama
  "importe neto" y NO es el neto gravado: es el bruto menos todos los
  cargos y todos los impuestos.
- El total de descuentos cuando incluye impuestos: "TOTAL DESCUENTO",
  "Total deducciones". Ese numero ya trae adentro el IVA y las retenciones,
  asi que no es la base gravada.
Además del neto en el campo correspondiente, devolvé el DESGLOSE en el
array "cargos": una entrada por cada cargo, con su rótulo tal como está
impreso en "concepto" y su importe en "importe". No los sumes ahí ni los
agrupes -- transcribí uno por uno, que la suma la hace el sistema.
Incluí también los que figuran en cero: que el resumen liste "Promociones
$0,00" es información, y omitirlo hace parecer que no lo miraste.
No pongas en "cargos" ni los impuestos (IVA, retenciones, percepciones,
que van en sus campos propios) ni las líneas señuelo de recién.
Verificación obligatoria antes de contestar: el IVA que figura en el
resumen tiene que ser el porcentaje declarado del neto gravado que
devolvés. Si el resumen dice IVA $914,74 y la alícuota es 21%, el neto
gravado tiene que dar cerca de $4.355,90 -- si lo que sumaste da la mitad,
te faltó un cargo: volvé a buscarlo. Esta cuenta es la mejor forma de
saber si sumaste todo.
Estos comprobantes traen casi siempre retenciones y percepciones de
Ingresos Brutos en el pie, y a veces varias juntas. Leelas con
atención: van en los pares percepN/imppercepN como en cualquier otro
comprobante, con la jurisdicción tal como figure. La app se encarga de
imputarlas; vos solo transcribí lo que dice.
Prestá atención a tres líneas que aparecen casi solo acá:
- SIRCREB: va en percepN, con su rótulo tal como figure.
- SIRTAC: NO va en percepN. Va en los pares variosN/impvariosN, con el
  rótulo tal como esté impreso en variosN ("Retención I.B. /SIRTAC",
  "Ret. SIRTAC", lo que figure) y el importe en impvariosN. El código de
  Tango lo pone la app: vos transcribí el texto.
- La percepción de la AFIP/DGI, que estas liquidaciones imprimen como
  "Percep./Retenc. AFIP - DGI", "Perc. IVA RG 2408" o parecido: es una
  PERCEPCIÓN DE IVA. NO va en variosN ni en percepN: va en un par
  porcivaN/impivaN, con el importe en impivaN y porcivaN vacío, porque no
  trae porcentaje propio. Es distinta del SIRTAC y de las líneas de
  Ingresos Brutos, aunque figuren una al lado de la otra en el mismo pie.`,

  remito: `Este comprobante es un REMITO de un proveedor: el papel que acompaña la
mercadería cuando llega. No tiene importes ni impuestos -- o si los tiene,
no se te piden: lo único que se registra es qué entró y cuánto.
El número de remito va en ptovta y nro como cualquier comprobante: de
"REMITO R 0001-00025490" sale ptovta "0001" y nro "00025490". En tipo
copiá cómo se llama el papel tal como está impreso ("Remito R", "Remito").
Si el remito cita una ORDEN DE COMPRA nuestra ("O.C.", "Orden de compra",
"Pedido", "N/Pedido", "Su OC"), copiá ese número en ordencompra tal como
figura. Si no la cita, dejalo vacío: no la deduzcas de otro número.
Transcribí el detalle en el array "renglonesPdf": una entrada por cada
artículo que entrega el remito, con estos datos tal como están impresos:
- "codigo": el CÓDIGO del artículo, y SOLO el código. Es el que imprime el
  proveedor: a veces es el mismo que usamos nosotros y a veces es el suyo
  propio; copiá el que figure, sin traducirlo. Si el renglón no trae
  código, dejalo vacío.
  Si el renglón tiene una COLUMNA APARTE con el color o la variante
  ("Color", "Col.", "Cod.Color"), ese valor ES PARTE DEL CÓDIGO y va
  incluido, separado por un espacio: "1261095 140".
- "descripcion": la DESCRIPCIÓN del artículo tal como está impresa, entera.
  Si el renglón trae abajo el desglose por talle ("L : 6  M : 4  S : 2"),
  copialo al final de la descripción tal como está impreso: cada talle es
  un artículo distinto para nosotros.
- "cantidad": la CANTIDAD entregada. Es el dato más importante del remito:
  leelo con cuidado. Si hay una columna de cantidad pedida y otra de
  entregada, va la ENTREGADA.
- "precioUnitario" y "subtotal": solo si el remito los imprime; si no,
  vacíos. No los calcules.
No metas en ese array los totales de bultos, kilos, el transporte ni las
leyendas del pie: solo la mercadería.`,
}

function armar(tipo: TipoFactura): string {
  // Un remito no tiene importes: las reglas de IVA, percepciones e impuestos
  // solo le harían buscar datos que no están y que no se le piden.
  const impuestos =
    tipo === 'remito' ? [] : [IVA_Y_PERCEPCIONES, SLOTS_IVA, PERCEPCIONES, IMPUESTOS_VARIOS]
  return [
    'Sos un asistente de cuentas a pagar. Leés comprobantes de compra argentinos',
    '(facturas A/B/C, notas de crédito y de débito, remitos) y extraés sus campos.',
    '',
    'Reglas:',
    '',
    ...numerar([
      LECTURA_LITERAL,
      CAMPO_AUSENTE,
      CONFIANZA,
      PUNTO_VENTA,
      quienEsElProveedor(process.env.PHF_CUIT_PROPIO?.trim() || null, tipo),
      SEGUN_TIPO[tipo],
      ...impuestos,
      MANUSCRITO,
    ]),
    '',
    'Campos a extraer:',
    '',
    ...camposIaPara(tipo).map((x) => `- ${x.clave}: ${x.label}`),
  ].join('\n')
}

/**
 * Un prompt por tipo de comprobante. Van en el bloque `system` con
 * cache_control: cada uno tiene que superar los 512 tokens que Opus 5 pide
 * como mínimo cacheable -- los superan holgado -- y ser byte a byte
 * idéntico entre llamadas del MISMO tipo, o el cache no pega. Por eso los
 * tres se arman una sola vez al importar el módulo y no llevan fecha ni
 * nada variable adentro. Tres prompts distintos son tres entradas de
 * cache, no una rota: el cache es por prefijo exacto.
 */
export const PROMPTS_EXTRACCION: Record<TipoFactura, string> = Object.fromEntries(
  TIPOS_FACTURA.map((t) => [t.clave, armar(t.clave)]),
) as Record<TipoFactura, string>

/** Va en el historial de auditoría, para saber con qué prompt se leyó. */
export const VERSION_PROMPT = 'v16'
