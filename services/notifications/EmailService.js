const sgMail = require('@sendgrid/mail');
const logger = require('../../shared/logger');
const { writeAuditLog } = require('../../shared/db/audit');

const TEMPLATES = {
  'verification_approved': {
    subject: '✅ TrustMed - Votre profil est maintenant vérifié',
    body: `Félicitations Dr. {full_name}, votre profil TrustMed a été vérifié.
Votre score de confiance: {trust_score}/100. Badge: {badge_level}.
Connectez-vous pour voir votre badge: {VERIFICATION_PORTAL_URL}`
  },
  'verification_rejected': {
    subject: '❌ TrustMed - Vérification refusée',
    body: `Dr. {full_name}, votre dossier n'a pas pu être vérifié.
Raison: {notes}
Vous pouvez soumettre un nouveau dossier avec des documents corrects.`
  },
  'more_info_required': {
    subject: '📋 TrustMed - Documents supplémentaires requis',
    body: `Dr. {full_name}, notre équipe a besoin d'informations supplémentaires:
{message}
Veuillez vous connecter et soumettre les documents demandés.`
  },
  'expiry_warning': {
    subject: '⚠️ TrustMed - Votre licence expire bientôt',
    body: `Dr. {full_name}, votre {doc_type} expire dans {days_remaining} jours.
Veuillez mettre à jour vos documents pour maintenir votre badge vérifié.`
  },
  'annual_resubmit_warning': {
    subject: '⚠️ TrustMed - Renouvellement annuel requis dans {days_remaining} jours',
    body: `Dr. {full_name}, votre badge TrustMed nécessite un renouvellement annuel.
Veuillez soumettre votre AGREMENT mis à jour avant la date d'échéance.
Connectez-vous: {portal_url}`
  },
  'annual_resubmit_overdue': {
    subject: '🔴 TrustMed - Badge rétrogradé - Renouvellement en retard',
    body: `Dr. {full_name}, votre badge TrustMed a été rétrogradé car votre
renouvellement annuel est en retard. Soumettez votre AGREMENT pour
restaurer votre statut FULLY_VERIFIED: {portal_url}`
  },
  'profile_deactivated_retired': {
    subject: 'TrustMed - Profil désactivé',
    body: `Dr. {full_name}, votre profil TrustMed a été désactivé car votre
statut CNOM indique que vous n'êtes plus en exercice actif.
Si cela est une erreur, contactez-nous à support@trustmed.dz`
  },
  'vouch_withdrawn': {
    subject: '⚠️ TrustMed - Un parrainage a été retiré',
    body: `Dr. {full_name}, un médecin a retiré son parrainage de votre profil.
Votre niveau de confiance a été mis à jour.
Vous avez besoin de {required} parrainages actifs pour maintenir votre badge FULLY_VERIFIED.
Connectez-vous pour voir votre statut: {portal_url}`
  },
  'institutional_verify': {
    subject: 'TrustMed - Vérification de votre email institutionnel',
    body: `Cliquez sur ce lien pour confirmer votre affiliation institutionnelle:
{verification_link}
Ce lien expire dans 24 heures.`
  }
};

class EmailService {
  constructor() {
    this.apiKey = process.env.SENDGRID_API_KEY;
    if (this.apiKey) {
      sgMail.setApiKey(this.apiKey);
    }
  }

  /**
   * Send an email using predefined templates.
   *
   * @param {string} to           - Recipient email address
   * @param {string} templateName - Name of the template to use
   * @param {object} variables    - Object with key-value pairs to replace in the template
   * @returns {object} { sent: true, provider: 'sendgrid'|'console' }
   */
  async sendEmail(to, templateName, variables = {}) {
    const template = TEMPLATES[templateName];
    if (!template) {
      throw new Error(`Unknown email template: ${templateName}`);
    }

    let subject = template.subject;
    let body = template.body;

    // Replace variables in subject and body
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`{${key}}`, 'g');
      subject = subject.replace(regex, value);
      body = body.replace(regex, value);
    }

    let provider = 'console';

    try {
      if (this.apiKey) {
        const msg = {
          to,
          from: 'noreply@trustmed.dz', // Update with actual verified sender in prod
          subject,
          text: body,
        };
        await sgMail.send(msg);
        provider = 'sendgrid';
      } else {
        logger.info('EMAIL (Console Fallback):', { to, subject, body });
      }

      await writeAuditLog({
        actorType: 'system',
        action: 'EMAIL_SENT',
        metadata: { to, template: templateName, provider },
      });

      return { sent: true, provider };
    } catch (err) {
      logger.error('Failed to send email', { error: err.message, to, templateName });
      throw err;
    }
  }
}

module.exports = EmailService;
