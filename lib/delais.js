// MARTEAU — alertes de délai d'audit (lib/, hors du plafond de fonctions).
//
// Arbitrages du 09/09/2026, codés le 09/11/2026 :
//   • à la création, on fixe le délai d'audit (10 à 180 jours) ; l'ÉCHÉANCE
//     = date d'ouverture + délai, calculée, jamais stockée ;
//   • alerte À QUINZE JOURS de l'échéance, pour les seuls audits de 30 jours
//     ou plus (les audits courts ont un point d'équipe chaque semaine) ;
//   • alerte À 48 HEURES pour TOUS les audits : générer, signer et adresser
//     la version définitive — en signalant les réserves encore ouvertes,
//     puisque le définitif ne se génère qu'à zéro réserve ;
//   • les alertes remontent à l'écran d'accueil ET dans la note de réunion.
// Ajout du 09/11/2026 (accord de JFD) : échéance DÉPASSÉE → alerte carmin
// « dépassée depuis N jours ».
//
// Les jours se comptent en dates calendaires (heure de Paris), pas en
// heures écoulées : « à 48 heures » veut dire aujourd'hui, demain ou
// après-demain.

const JOUR = 86400000;

// Date du jour à Paris, en AAAA-MM-JJ : le serveur tourne en UTC, et un
// dossier consulté à 0 h 30 ne doit pas perdre un jour.
function aujourdhuiParis(maintenant = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(maintenant);
}

export function echeanceAudit(ouvert_le, delai) {
  if (!ouvert_le || !delai) return null;
  const depart = aujourdhuiParis(new Date(ouvert_le));
  const d = new Date(depart + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(delai));
  return d.toISOString().slice(0, 10);
}

const jourFr = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const pluriel = (n, mot) => n + ' ' + mot + (n > 1 ? 's' : '');

// Rend null (rien à signaler, ou délai non renseigné) ou
// { niveau: 'depassee' | 'h48' | 'j15', couleur, jours, echeance, texte }.
// `jours` = jours restants (négatif si dépassée).
export function alerteDelai({ ouvert_le, delai_audit_jours, reserves_ouvertes = 0 }, maintenant = new Date()) {
  const echeance = echeanceAudit(ouvert_le, delai_audit_jours);
  if (!echeance) return null;
  const jours = Math.round((Date.parse(echeance + 'T12:00:00Z') - Date.parse(aujourdhuiParis(maintenant) + 'T12:00:00Z')) / JOUR);
  const res = reserves_ouvertes
    ? ' — ' + pluriel(reserves_ouvertes, 'réserve') + ' encore ouverte' + (reserves_ouvertes > 1 ? 's' : '') + ' : le définitif ne peut pas se générer'
    : '';

  if (jours < 0) {
    return { niveau: 'depassee', couleur: 'carmin', jours, echeance,
      texte: 'Échéance de l’audit dépassée depuis ' + pluriel(-jours, 'jour') + ' (échéance le ' + jourFr(echeance) + ')' + res };
  }
  if (jours <= 2) {
    const quand = jours === 0 ? 'aujourd’hui' : jours === 1 ? 'demain' : 'dans 2 jours';
    return { niveau: 'h48', couleur: 'carmin', jours, echeance,
      texte: 'Échéance de l’audit ' + quand + ', le ' + jourFr(echeance) + ' : générer, signer et adresser la version définitive' + res };
  }
  if (Number(delai_audit_jours) >= 30 && jours <= 15) {
    return { niveau: 'j15', couleur: 'orange', jours, echeance,
      texte: 'Échéance de l’audit dans ' + pluriel(jours, 'jour') + ', le ' + jourFr(echeance) };
  }
  return null;
}
