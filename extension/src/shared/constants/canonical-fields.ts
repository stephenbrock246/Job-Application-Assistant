/**
 * Canonical field registry (spec sections 7 and 9).
 *
 * This is the single place that decides, for a given piece of information:
 *   - what we call it,
 *   - which question wordings map onto it,
 *   - where its value lives in the applicant profile,
 *   - and - critically - which category it belongs to.
 *
 * The category is load-bearing: the autofill engine refuses to write a value for
 * USER_CONFIRMATION_REQUIRED fields no matter how confident the classifier is.
 */

import type { QuestionCategory } from '../types/application'
import type { ApplicantProfile } from '../types/profile'

export interface CanonicalFieldDef {
  key: string
  label: string
  category: QuestionCategory
  /** Where the value lives in the profile, if it does. */
  read?: (profile: ApplicantProfile) => string
  /** Question wordings that map to this field, normalised before comparison. */
  aliases: string[]
}

const P = <K extends keyof ApplicantProfile>(section: K, field: keyof ApplicantProfile[K]) => {
  return (profile: ApplicantProfile): string => {
    const value = profile[section][field]
    return typeof value === 'string' ? value : ''
  }
}

export const CANONICAL_FIELDS: CanonicalFieldDef[] = [
  // ---- GLOBAL: safe, reusable profile information -------------------------
  {
    key: 'firstName',
    label: 'First name',
    category: 'GLOBAL',
    read: P('personal', 'firstName'),
    aliases: ['first name', 'given name', 'forename', 'legal first name'],
  },
  {
    key: 'middleName',
    label: 'Middle name',
    category: 'GLOBAL',
    read: P('personal', 'middleName'),
    aliases: ['middle name', 'middle initial'],
  },
  {
    key: 'lastName',
    label: 'Last name',
    category: 'GLOBAL',
    read: P('personal', 'lastName'),
    aliases: ['last name', 'surname', 'family name', 'legal last name'],
  },
  {
    key: 'fullName',
    label: 'Full name',
    category: 'GLOBAL',
    read: P('personal', 'fullName'),
    aliases: ['full name', 'name', 'your name', 'applicant name', 'legal name'],
  },
  {
    key: 'email',
    label: 'Email address',
    category: 'GLOBAL',
    read: P('personal', 'email'),
    aliases: ['email', 'email address', 'e-mail', 'contact email'],
  },
  {
    key: 'phone',
    label: 'Phone number',
    category: 'GLOBAL',
    read: P('personal', 'phone'),
    aliases: ['phone', 'phone number', 'mobile', 'mobile number', 'telephone', 'contact number'],
  },
  {
    key: 'address',
    label: 'Street address',
    category: 'GLOBAL',
    read: P('personal', 'address'),
    aliases: ['address', 'street address', 'address line 1', 'mailing address'],
  },
  {
    key: 'city',
    label: 'City',
    category: 'GLOBAL',
    read: P('personal', 'city'),
    aliases: ['city', 'town', 'city of residence'],
  },
  {
    key: 'state',
    label: 'State / Province',
    category: 'GLOBAL',
    read: P('personal', 'state'),
    aliases: ['state', 'province', 'region', 'state/province'],
  },
  {
    key: 'zip',
    label: 'ZIP / Postcode',
    category: 'GLOBAL',
    read: P('personal', 'zip'),
    aliases: ['zip', 'zip code', 'postal code', 'postcode'],
  },
  {
    key: 'country',
    label: 'Country',
    category: 'GLOBAL',
    read: P('personal', 'country'),
    aliases: ['country', 'country of residence'],
  },
  {
    key: 'location',
    label: 'Location',
    category: 'GLOBAL',
    read: (p) => [p.personal.city, p.personal.state].filter(Boolean).join(', '),
    aliases: ['location', 'current location', 'where are you located', 'your location'],
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    category: 'GLOBAL',
    read: P('personal', 'linkedin'),
    aliases: ['linkedin', 'linkedin profile', 'linkedin url', 'linkedin profile url'],
  },
  {
    key: 'github',
    label: 'GitHub',
    category: 'GLOBAL',
    read: P('personal', 'github'),
    aliases: ['github', 'github profile', 'github url'],
  },
  {
    key: 'portfolio',
    label: 'Portfolio / Website',
    category: 'GLOBAL',
    read: P('personal', 'portfolio'),
    aliases: ['portfolio', 'website', 'personal website', 'portfolio url', 'other website'],
  },
  {
    key: 'currentTitle',
    label: 'Current job title',
    category: 'GLOBAL',
    read: P('professional', 'currentTitle'),
    aliases: ['current title', 'current job title', 'job title', 'current role', 'present title'],
  },
  {
    key: 'currentCompany',
    label: 'Current company',
    category: 'GLOBAL',
    read: P('professional', 'currentCompany'),
    aliases: ['current company', 'current employer', 'employer', 'present company'],
  },
  {
    key: 'yearsOfExperience',
    label: 'Years of experience',
    category: 'GLOBAL',
    read: P('professional', 'yearsOfExperience'),
    aliases: [
      'years of experience',
      'total experience',
      'how many years of experience',
      'years experience',
      'experience in years',
    ],
  },
  {
    key: 'education',
    label: 'Education',
    category: 'GLOBAL',
    read: P('professional', 'education'),
    aliases: ['education', 'highest education', 'degree', 'highest degree', 'qualification'],
  },
  {
    key: 'noticePeriod',
    label: 'Notice period',
    category: 'GLOBAL',
    read: P('preferences', 'noticePeriod'),
    aliases: [
      'notice period',
      'current notice period',
      'how soon can you start',
      'how much notice',
      'notice',
    ],
  },
  {
    key: 'workAuthorization',
    label: 'Work authorization',
    category: 'GLOBAL',
    read: P('workAuthorization', 'workAuthorization'),
    aliases: [
      'work authorization',
      'are you authorized to work',
      'authorized to work',
      'right to work',
      'work permit',
      'eligible to work',
    ],
  },
  {
    key: 'sponsorshipRequired',
    label: 'Sponsorship requirement',
    category: 'GLOBAL',
    read: P('workAuthorization', 'sponsorshipRequired'),
    aliases: [
      'sponsorship',
      'require sponsorship',
      'will you now or in the future require sponsorship',
      'visa sponsorship',
      'need sponsorship',
    ],
  },

  // ---- JOB_DEPENDENT: may legitimately differ per job ---------------------
  {
    key: 'expectedSalary',
    label: 'Expected salary',
    category: 'JOB_DEPENDENT',
    read: P('preferences', 'expectedSalary'),
    aliases: [
      'expected salary',
      'desired salary',
      'salary expectation',
      'salary expectations',
      'expected compensation',
      'desired compensation',
      'compensation expectation',
      'salary requirement',
      'expected ctc',
    ],
  },
  {
    key: 'availableStartDate',
    label: 'Available start date',
    category: 'JOB_DEPENDENT',
    read: P('preferences', 'availableStartDate'),
    aliases: ['start date', 'available start date', 'earliest start date', 'when can you start'],
  },
  {
    key: 'preferredLocation',
    label: 'Preferred location',
    category: 'JOB_DEPENDENT',
    read: P('preferences', 'preferredLocation'),
    aliases: ['preferred location', 'desired location', 'preferred work location'],
  },
  {
    key: 'remotePreference',
    label: 'Remote preference',
    category: 'JOB_DEPENDENT',
    read: P('preferences', 'remotePreference'),
    aliases: ['remote preference', 'work preference', 'remote or onsite', 'work arrangement'],
  },
  {
    key: 'relocationPreference',
    label: 'Relocation',
    category: 'JOB_DEPENDENT',
    read: P('preferences', 'relocationPreference'),
    aliases: ['relocate', 'willing to relocate', 'relocation', 'open to relocation'],
  },
  {
    key: 'desiredPosition',
    label: 'Desired position',
    category: 'JOB_DEPENDENT',
    aliases: ['position applying for', 'desired position', 'role applying for', 'position of interest'],
  },

  // ---- AI_GENERATED: drafted from resume + JD, always reviewed ------------
  // Listed first so "Cover letter / additional information" resolves to the letter:
  // on an equal match the earlier entry wins.
  {
    key: 'coverLetter',
    label: 'Cover letter',
    category: 'AI_GENERATED',
    aliases: [
      'cover letter',
      'cover letter text',
      'message to hiring manager',
      'message to the hiring manager',
      'motivation letter',
      'letter of motivation',
    ],
  },
  {
    key: 'whyInterested',
    label: 'Why are you interested in this position?',
    category: 'AI_GENERATED',
    aliases: [
      'why are you interested',
      'why this role',
      'why do you want this job',
      'what interests you about this position',
    ],
  },
  {
    key: 'whyCompany',
    label: 'Why do you want to work here?',
    category: 'AI_GENERATED',
    aliases: ['why do you want to work here', 'why our company', 'why us', 'what draws you to'],
  },
  {
    key: 'relevantExperience',
    label: 'Describe relevant experience',
    category: 'AI_GENERATED',
    aliases: [
      'relevant experience',
      'describe your experience',
      'tell us about your experience',
      'how does your experience relate',
    ],
  },
  {
    key: 'additionalInformation',
    label: 'Additional information',
    category: 'AI_GENERATED',
    aliases: ['additional information', 'anything else', 'additional comments'],
  },

  // ---- USER_CONFIRMATION_REQUIRED: never auto-answered --------------------
  {
    key: 'legalAttestation',
    label: 'Legal attestation',
    category: 'USER_CONFIRMATION_REQUIRED',
    aliases: [
      'i certify',
      'i attest',
      'certify that the information',
      'accuracy of the information',
      'terms and conditions',
      'privacy policy',
      'conflict of interest',
    ],
  },
  {
    key: 'electronicSignature',
    label: 'Electronic signature',
    category: 'USER_CONFIRMATION_REQUIRED',
    aliases: ['signature', 'electronic signature', 'e-signature', 'sign here', 'type your name to sign'],
  },
  // Voluntary self-identification: still USER_CONFIRMATION_REQUIRED. They are
  // answered only with the exact answer the user typed into the profile's
  // "Voluntary self-identification" section - blank there means never.
  {
    key: 'gender',
    label: 'Gender (voluntary)',
    category: 'USER_CONFIRMATION_REQUIRED',
    read: P('voluntary', 'gender'),
    aliases: ['gender', 'gender identity', 'sex'],
  },
  {
    key: 'raceEthnicity',
    label: 'Race / ethnicity (voluntary)',
    category: 'USER_CONFIRMATION_REQUIRED',
    read: P('voluntary', 'raceEthnicity'),
    aliases: ['race', 'ethnicity', 'race/ethnicity', 'hispanic or latino'],
  },
  {
    key: 'disabilityStatus',
    label: 'Disability status (voluntary)',
    category: 'USER_CONFIRMATION_REQUIRED',
    read: P('voluntary', 'disabilityStatus'),
    aliases: ['disability', 'disability status', 'do you have a disability'],
  },
  {
    key: 'veteranStatus',
    label: 'Veteran status (voluntary)',
    category: 'USER_CONFIRMATION_REQUIRED',
    read: P('voluntary', 'veteranStatus'),
    aliases: ['veteran', 'veteran status', 'protected veteran'],
  },
]

/**
 * The only USER_CONFIRMATION_REQUIRED fields that may ever be filled - and only
 * from the user's own explicit answer. Legal attestations and signatures are not
 * here and never will be.
 */
export const VOLUNTARY_KEYS = new Set(['gender', 'raceEthnicity', 'disabilityStatus', 'veteranStatus'])

export const CANONICAL_FIELD_BY_KEY = new Map(CANONICAL_FIELDS.map((f) => [f.key, f]))

/** Categories the autofill engine is allowed to write without asking first. */
export const AUTO_FILLABLE_CATEGORIES: QuestionCategory[] = ['GLOBAL', 'JOB_DEPENDENT']

export function isAutoFillable(category: QuestionCategory | undefined): boolean {
  return category !== undefined && AUTO_FILLABLE_CATEGORIES.includes(category)
}

/** Fields shown in the "Autofill Information" summary card, in display order. */
export const AUTOFILL_SUMMARY_KEYS = [
  'email',
  'location',
  'expectedSalary',
  'workAuthorization',
  'noticePeriod',
] as const
