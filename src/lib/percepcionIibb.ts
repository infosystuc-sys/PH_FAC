/**
 * Códigos de percepción de IIBB válidos para esta app, con su jurisdicción.
 * Restringido a mano por decisión del usuario: CPA14 tiene más códigos que
 * empiezan "IIBB" pero son retenciones (64, 66...), no percepciones, y
 * mezclarlos escribiría mal el dato en CPA18 — ver RETOMAR.md. Es la fuente
 * única que usan tanto el prompt de extracción (para que Claude sepa qué
 * código sugerir) como el filtro de opciones del selector del formulario.
 */
export const JURISDICCIONES_IIBB: { codigo: string; jurisdiccion: string }[] = [
  { codigo: '60', jurisdiccion: 'Tucumán' },
  { codigo: '61', jurisdiccion: 'Salta' },
  { codigo: '62', jurisdiccion: 'CABA' },
  { codigo: '68', jurisdiccion: 'Formosa' },
]
