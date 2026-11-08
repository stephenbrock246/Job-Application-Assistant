/** Applicant profile - spec section 6. Everything here is user-entered; nothing is inferred. */

export interface PersonalInformation {
  firstName: string
  middleName: string
  lastName: string
  fullName: string
  email: string
  phone: string
  address: string
  city: string
  state: string
  zip: string
  country: string
  linkedin: string
  github: string
  portfolio: string
}

export interface ProfessionalInformation {
  currentTitle: string
  currentCompany: string
  yearsOfExperience: string
  primarySkills: string
  education: string
}

export type SalaryPeriod = 'hourly' | 'monthly' | 'yearly'
export type RemotePreference = 'remote' | 'hybrid' | 'onsite' | 'flexible' | ''
export type RelocationPreference = 'yes' | 'no' | 'negotiable' | ''

export interface JobPreferences {
  expectedSalary: string
  salaryCurrency: string
  salaryPeriod: SalaryPeriod
  preferredLocation: string
  remotePreference: RemotePreference
  relocationPreference: RelocationPreference
  noticePeriod: string
  availableStartDate: string
}

export interface WorkAuthorization {
  workAuthorization: string
  sponsorshipRequired: string
}

/**
 * Voluntary self-identification (EEO) answers. Blank = never answered for you,
 * which is the default. Filled = the user has explicitly chosen to have that exact
 * answer given whenever a form asks.
 */
export interface VoluntaryAnswers {
  gender: string
  raceEthnicity: string
  veteranStatus: string
  disabilityStatus: string
}

export interface ApplicantProfile {
  personal: PersonalInformation
  professional: ProfessionalInformation
  preferences: JobPreferences
  workAuthorization: WorkAuthorization
  voluntary: VoluntaryAnswers
  updatedAt: number
}
