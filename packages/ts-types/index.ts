export interface UserProfile {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
  skills: UserSkillDto[];
  verifiedDeployments: VerifiedDeploymentDto[];
  achievements: AchievementDto[];
}

export interface UserSkillDto {
  name: string;
  category: 'language' | 'framework' | 'database' | 'devops' | 'Language' | 'Frontend' | 'Backend' | 'Database' | 'Cloud & DevOps' | string;
  proficiencyScore: number;
  linesWritten: number;
  projectsCount: number;
}

export interface VerifiedDeploymentDto {
  id: string;
  url: string;
  provider: string;
  uptimePercentage: number;
  lastVerifiedAt: string | null;
  reports: VerificationReportDto[];
}

export interface VerificationReportDto {
  id: string;
  status: 'healthy' | 'degraded' | 'offline';
  sslValid: boolean;
  sslIssuer: string | null;
  sslExpiresAt: string | null;
  responseTimeMs: number;
  lighthousePerfScore: number;
  screenshotUrl: string | null;
  consoleErrors: any;
  ledgerSignature: string | null;
  createdAt: string;
}

export interface AchievementDto {
  id: string;
  title: string;
  description: string;
  badgeIconUrl: string;
  criteriaType: string;
  unlockedAt: string;
}

export interface AnalyzeRepositoryRequest {
  repositoryName: string;
  owner: string;
}

export interface VerifyDeploymentRequest {
  repositoryId: string;
  url: string;
}

export interface AnalyzeUserRequest {
  username: string;
}

export interface AnalyzeUserResponse {
  user: {
    id: string;
    githubId: string | null;
    username: string;
    displayName: string | null;
    name: string | null;
    avatarUrl: string | null;
    bio: string | null;
    followers: number;
    following: number;
    publicRepos: number;
    createdAt: string;
  };
  repositories: Array<{
    id: string;
    repositoryId: string | null;
    userId: string;
    name: string;
    fullName: string;
    description: string | null;
    language: string | null;
    stars: number;
    forks: number;
    topics: string[];
    complexityScore: number;
    createdAt: string;
  }>;
  analysisStatus: string;
  jobId?: string;
}

export interface DeveloperMetricsDto {
  vds: number;
  grade: string;
  rank: string;
  skillScore: number;
  contributionScore: number;
  trustScore: number;
  repositoryComplexity: number;
  activityScore: number;
  projectDiversity: number;
  aiAuditScore: number;
}

export interface ContributionAnalysisDto {
  totalCommits: number;
  userCommits: number;
  contributionPercentage: number;
  linesAdded: number;
  linesDeleted: number;
  activeDays: number;
  commitConsistency: number;
  avgCommitsPerWeek: number;
  contributionScore: number;
  activityScore: number;
  trustScore: number;
  ownershipScore: number;
  consistencyScore: number;
  ownershipConfidence: number;
  commitQualityScore: number;
}

export interface UserMetricsResponse {
  username: string;
  metrics: DeveloperMetricsDto | null;
  repositories: Array<{
    id: string;
    name: string;
    fullName: string;
    isFork: boolean;
    complexityScore: number;
    contributionAnalysis: ContributionAnalysisDto | null;
  }>;
}

export interface UserVdsResponse {
  vds: number;
  grade: string;
  rank: string;
  breakdown: {
    skillScore: number;
    contributionScore: number;
    trustScore: number;
    repositoryComplexity: number;
    activityScore: number;
    projectDiversity: number;
    aiAuditScore: number;
  };
}

export interface RecruiterReportDto {
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  followers: number;
  publicRepos: number;
  createdAt: string;
  vds: UserVdsResponse;
  skills: UserSkillDto[];
  repositories: Array<{
    name: string;
    fullName: string;
    description: string | null;
    language: string | null;
    stars: number;
    forks: number;
    complexityScore: number;
    contributionAnalysis: ContributionAnalysisDto | null;
    aiAudit: {
      readabilityScore: number;
      modularityScore: number;
      securityScore: number;
      summary: string;
      vulnerabilities: string[];
      improvements: string[];
    } | null;
  }>;
  achievements: Array<{
    title: string;
    description: string;
    badgeIconUrl: string;
  }>;
  ledgerEntries: Array<{
    eventType: string;
    targetId: string;
    payload: any;
    cryptographicProof: string;
    createdAt: string;
  }>;
}

