import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GithubApiService } from './github-api.service';
import { assessCommitMsgQuality } from '../repositories/scoring.util';

export function isCommitAuthor(c: any, username: string, profile: any): boolean {
  const lowerUsername = username.toLowerCase();
  
  // 1. Match by commit author login
  if (c.author?.login?.toLowerCase() === lowerUsername) return true;
  if (c.authorLogin?.toLowerCase() === lowerUsername) return true;
  
  // 2. Match by GitHub user id
  if (c.author?.id && profile?.id && String(c.author.id) === String(profile.id)) return true;
  
  // 3. Match by name / display name
  const authorName = (c.commit?.author?.name || c.authorName || '').toLowerCase();
  if (authorName === lowerUsername) return true;
  if (profile?.name && authorName === profile.name.toLowerCase()) return true;
  
  // 4. Match by email prefix or full email
  const authorEmail = (c.commit?.author?.email || c.authorEmail || '').toLowerCase();
  if (profile?.email && authorEmail === profile.email.toLowerCase()) return true;
  if (authorEmail.startsWith(`${lowerUsername}@`)) return true;

  return false;
}

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);

  // In-memory fallback caches
  private mockMetrics = new Map<string, any>();
  private mockRepoAnalyses = new Map<string, any>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly githubApi: GithubApiService
  ) {}

  async calculateAndStoreMetrics(username: string, userId: string): Promise<any> {
    this.logger.log(`Starting scoring metrics calculation for user: ${username}`);
    const lowerUsername = username.toLowerCase();

    // Fetch user profile from GitHub API to match author details dynamically
    let profile: any = null;
    try {
      profile = await this.githubApi.getProfile(lowerUsername);
    } catch (err) {
      this.logger.warn(`Failed fetching profile in ScoringService: ${err.message}`);
    }

    // 1. Load repositories and user skills
    let repos: any[] = [];
    let skills: any[] = [];
    let ledgerEntries: any[] = [];

    try {
      repos = await this.prisma.repository.findMany({
        where: { userId },
        include: { commits: true },
      });
      skills = await this.prisma.userSkill.findMany({
        where: { userId },
        include: { skill: true },
      });
      ledgerEntries = await this.prisma.proofLedger.findMany({
        where: { userId },
      });
    } catch (err) {
      this.logger.warn(`Prisma failed fetching user data for scoring: ${err.message}. Using fallback records.`);
      // Load from Github API fallback
      const githubRepos = await this.githubApi.getRepositories(lowerUsername);
      repos = githubRepos.map((r, idx) => ({
        id: `repo_${r.id}`,
        name: r.name,
        fullName: r.fullName,
        description: r.description,
        language: r.language,
        starsCount: r.stars,
        forksCount: r.forks,
        topics: r.topics,
        isFork: r.isFork,
        complexityScore: idx === 0 ? 82 : idx === 1 ? 74 : 65,
        repoCreatedAt: new Date(r.createdAt),
      }));

      // Map mock skills
      skills = [
        { proficiencyScore: 90, linesWritten: 12400, projectsCount: 4, skill: { name: 'TypeScript', category: 'language' } },
        { proficiencyScore: 95, linesWritten: 18200, projectsCount: 6, skill: { name: 'NodeJS', category: 'framework' } }
      ];
    }

    const analyses: any[] = [];
    let totalContribution = 0;
    let totalTrust = 0;
    let totalComplexity = 0;
    let totalAiAudit = 0;
    let totalCommitQuality = 0;
    let totalOwnership = 0;
    let countAnalyzed = 0;

    // Collect all user commits across repos for overall activity analysis
    const allUserCommits: any[] = [];

    // 2. Perform contribution analysis for each repository
    for (const repo of repos) {
      const repoName = repo.name;
      const isFork = repo.isFork || false;

      // Fetch actual stats from GitHub API
      let stats: any[] = [];
      let commits: any[] = [];
      let prs: any[] = [];
      let issues: any[] = [];

      try {
        stats = await this.githubApi.getContributorsStats(lowerUsername, repoName);
        commits = await this.githubApi.getCommits(lowerUsername, repoName);
        prs = await this.githubApi.getPullRequests(lowerUsername, repoName);
        issues = await this.githubApi.getIssues(lowerUsername, repoName);
      } catch (err) {
        this.logger.warn(`Failed to fetch stats/commits for ${repoName}: ${err.message}`);
      }

      // Calculations
      let totalCommits = 0;
      let userCommits = 0;
      let linesAdded = 0;
      let linesDeleted = 0;

      // Extract user week contribution details
      const userStats = stats.find(
        (s: any) => s.author?.login?.toLowerCase() === lowerUsername
      );
      
      // Calculate total commits from stats
      stats.forEach((s: any) => {
        totalCommits += s.total || 0;
      });

      if (userStats) {
        userCommits = userStats.total || 0;
        userStats.weeks?.forEach((w: any) => {
          linesAdded += w.a || 0;
          linesDeleted += w.d || 0;
        });
      } else {
        // Safe defaults from commits list
        userCommits = commits.filter((c: any) => isCommitAuthor(c, lowerUsername, profile)).length;
        totalCommits = Math.max(commits.length, userCommits);
        linesAdded = userCommits * 150;
        linesDeleted = userCommits * 30;
      }

      if (totalCommits === 0) totalCommits = 1; // Prevent division by zero
      const contributionPercentage = parseFloat(((userCommits / totalCommits) * 100).toFixed(2));

      // Active days (unique commit dates)
      const userCommitsList = commits.filter(
        (c: any) => isCommitAuthor(c, lowerUsername, profile)
      );

      // Append to the list of user commits for overall activity calculations
      userCommitsList.forEach((uc) => {
        allUserCommits.push({
          ...uc,
          repoCreatedAt: repo.repoCreatedAt || new Date(Date.now() - 90 * 24 * 3600 * 1000)
        });
      });

      const uniqueDays = new Set(
        userCommitsList.map((c: any) => {
          const date = c.commit?.author?.date || c.commitDate;
          return date ? date.split('T')[0] : '';
        }).filter(Boolean)
      );
      const activeDays = uniqueDays.size;

      // Duration & consistency
      const repoCreatedAt = repo.repoCreatedAt ? new Date(repo.repoCreatedAt) : new Date(Date.now() - 90 * 24 * 3600 * 1000);
      const totalWeeks = Math.max(1, Math.round((Date.now() - repoCreatedAt.getTime()) / (7 * 24 * 3600 * 1000)));
      const avgCommitsPerWeek = parseFloat((userCommits / totalWeeks).toFixed(2));

      // Active weeks consistency
      const activeWeeksSet = new Set(
        userCommitsList.map((c: any) => {
          const dateStr = c.commit?.author?.date || c.commitDate;
          if (!dateStr) return '';
          const d = new Date(dateStr);
          const oneJan = new Date(d.getFullYear(), 0, 1);
          const week = Math.ceil((((d.getTime() - oneJan.getTime()) / 86400000) + oneJan.getDay() + 1) / 7);
          return `${d.getFullYear()}-W${week}`;
        }).filter(Boolean)
      );
      const activeWeeks = activeWeeksSet.size;
      const commitConsistency = Math.min(100, Math.round((activeWeeks / Math.min(12, totalWeeks)) * 100));

      // 1. Commit Quality Score (Message, Consistency, Significance)
      let messageQualitySum = 0;
      userCommitsList.forEach((c: any) => {
        const msg = (c.commit?.message || c.message || '').trim();
        const msgLower = msg.toLowerCase();
        
        if (msg.length < 5) {
          messageQualitySum += 10;
        } else if (/^(feat|fix|docs|test|chore|refactor|style|ci)(?:\(.+?\))?!?:/.test(msgLower) && msg.length >= 10) {
          messageQualitySum += 100;
        } else if (msg.length >= 15) {
          messageQualitySum += 80;
        } else {
          messageQualitySum += 50;
        }
      });
      const avgMessageQuality = userCommitsList.length > 0 ? (messageQualitySum / userCommitsList.length) : 75;

      const avgLinesChanged = userCommits > 0 ? (linesAdded + linesDeleted) / userCommits : 0;
      const significanceScore = Math.min(100, Math.round(Math.log10(avgLinesChanged + 1) * 40));

      const commitQualityScore = Math.min(100, Math.max(0, Math.round(
        (avgMessageQuality * 0.40) +
        (commitConsistency * 0.30) +
        (significanceScore * 0.30)
      )));

      // 2. Ownership Score
      const isCreator = repo.fullName?.split('/')[0]?.toLowerCase() === lowerUsername;
      const creatorScore = isCreator ? 40 : 10;
      const commitVolumeScore = Math.min(30, (userCommits / totalCommits) * 30);
      
      let totalRepoLines = 0;
      stats.forEach((s: any) => {
        s.weeks?.forEach((w: any) => {
          totalRepoLines += (w.a || 0) + (w.d || 0);
        });
      });
      if (totalRepoLines === 0) {
        totalRepoLines = linesAdded + linesDeleted;
      }
      const linesScore = Math.min(20, ((linesAdded + linesDeleted) / (totalRepoLines + 1)) * 20);

      const mergedPRs = prs.filter(p => 
        p.user?.login?.toLowerCase() === lowerUsername && 
        p.merged_at !== null
      ).length;
      const prMergedScore = Math.min(10, mergedPRs * 5);

      const ownershipScore = Math.min(100, Math.round(creatorScore + commitVolumeScore + linesScore + prMergedScore));

      // 3. Contribution Score
      const volumeScore = Math.min(50, Math.round(Math.log10(linesAdded + 1) * 12.5));
      const pctScore = contributionPercentage * 0.5;
      const contributionScore = Math.round(volumeScore + pctScore);

      // 4. Activity Score (Single repository)
      const activityScore = Math.min(100, Math.round((userCommits * 1.5) + (activeDays * 4) + (avgCommitsPerWeek * 8)));

      // 5. Trust Score (Single repository)
      const starsCount = repo.starsCount || repo.stars || 0;
      
      const trustScore = Math.round(
        (ownershipScore * 0.40) +
        (commitQualityScore * 0.30) +
        ((isFork ? 40 : 100) * 0.20) +
        (Math.min(100, starsCount * 5) * 0.10)
      );

      const contributionAnalysis = {
        totalCommits,
        userCommits,
        contributionPercentage,
        linesAdded,
        linesDeleted,
        activeDays,
        commitConsistency,
        avgCommitsPerWeek,
        contributionScore,
        activityScore,
        trustScore,
        ownershipScore,
        consistencyScore: commitConsistency,
        ownershipConfidence: ownershipScore,
        commitQualityScore,
      };

      analyses.push({
        repoId: repo.id,
        repoName,
        isFork,
        complexityScore: repo.complexityScore || 70,
        contributionAnalysis
      });

      totalContribution += contributionScore;
      totalTrust += trustScore;
      totalComplexity += (repo.complexityScore || 70);
      totalCommitQuality += commitQualityScore;
      totalOwnership += ownershipScore;
      
      // Calculate repo AI Audit score
      const audit = repo.aiAudit || { readabilityScore: 82, modularityScore: 85, securityScore: 80 };
      const auditAvg = (audit.readabilityScore + audit.modularityScore + audit.securityScore) / 3;
      totalAiAudit += auditAvg;

      countAnalyzed++;

      // Save Contribution Analysis in DB
      try {
        await this.prisma.contributionAnalysis.upsert({
          where: { repositoryId: repo.id },
          update: contributionAnalysis,
          create: {
            repositoryId: repo.id,
            ...contributionAnalysis,
          },
        });
      } catch (dbErr) {
        this.logger.warn(`Failed to store contribution analysis to DB for ${repoName}: ${dbErr.message}`);
      }
    }

    // 3. Compute overall user activity score based on recent commits
    let commits30d = 0;
    let commits90d = 0;
    let commits365d = 0;
    const uniqueDays90d = new Set<string>();

    const now = new Date();
    const date30d = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const date90d = new Date(now.getTime() - 90 * 24 * 3600 * 1000);
    const date365d = new Date(now.getTime() - 365 * 24 * 3600 * 1000);

    allUserCommits.forEach(c => {
      const commitDateStr = c.commit?.author?.date || c.commitDate;
      if (!commitDateStr) return;
      const cDate = new Date(commitDateStr);
      const dateStr = commitDateStr.split('T')[0];

      if (cDate >= date30d) commits30d++;
      if (cDate >= date90d) {
        commits90d++;
        uniqueDays90d.add(dateStr);
      }
      if (cDate >= date365d) commits365d++;
    });

    const recentActivity = (commits30d * 4) + (commits90d * 1.5) + (commits365d * 0.2);
    const activityConsistency = Math.min(40, uniqueDays90d.size * 4);
    const finalActivityScore = Math.min(100, Math.max(10, Math.round(Math.min(60, recentActivity) + activityConsistency)));

    // Compute overall Trust Score
    const avgRepoTrust = countAnalyzed > 0 ? (totalTrust / countAnalyzed) : 50;
    const repoCountBonus = repos.length >= 5 ? 10 : repos.length >= 3 ? 5 : repos.length === 1 ? -10 : 0;
    const finalTrustScore = Math.min(100, Math.max(10, Math.round(avgRepoTrust + repoCountBonus)));

    // 4. Compute VDS Sub-scores
    const skillScore = skills.length > 0 
      ? Math.round(skills.reduce((acc, curr) => acc + (curr.proficiencyScore || 0), 0) / skills.length)
      : 75;

    const avgContribution = countAnalyzed > 0 ? Math.round(totalContribution / countAnalyzed) : 75;
    const avgComplexity = countAnalyzed > 0 ? Math.round(totalComplexity / countAnalyzed) : 70;
    const avgAiAudit = countAnalyzed > 0 ? Math.round(totalAiAudit / countAnalyzed) : 78;
    const avgCommitQuality = countAnalyzed > 0 ? Math.round(totalCommitQuality / countAnalyzed) : 80;
    const avgOwnership = countAnalyzed > 0 ? Math.round(totalOwnership / countAnalyzed) : 75;

    // Project Diversity Categories
    const categories = new Set<string>();
    repos.forEach((r) => {
      const name = r.name?.toLowerCase() || '';
      const desc = r.description?.toLowerCase() || '';
      const lang = r.language?.toLowerCase() || '';
      const topics = (r.topics || []).map((t: string) => t.toLowerCase());

      // AI
      if (topics.some((t) => ['ai', 'ml', 'machine-learning', 'llm', 'generative-ai', 'openai', 'tensorflow', 'pytorch'].includes(t)) ||
          name.includes('ai') || desc.includes('model') || desc.includes('generative')) {
        categories.add('AI');
      }
      // Web
      if (topics.some((t) => ['react', 'nextjs', 'vue', 'angular', 'html', 'css', 'javascript', 'typescript', 'nest'].includes(t)) ||
          ['typescript', 'javascript', 'html', 'css'].includes(lang)) {
        categories.add('Web');
      }
      // Mobile
      if (topics.some((t) => ['android', 'ios', 'swift', 'kotlin', 'flutter', 'react-native'].includes(t))) {
        categories.add('Mobile');
      }
      // DevOps
      if (topics.some((t) => ['docker', 'kubernetes', 'aws', 'terraform', 'ci-cd', 'github-actions'].includes(t)) ||
          desc.includes('docker') || desc.includes('ci/cd')) {
        categories.add('DevOps');
      }
      // Data Science
      if (topics.some((t) => ['data-science', 'pandas', 'numpy', 'r', 'jupyter'].includes(t))) {
        categories.add('Data Science');
      }
      // Cybersecurity
      if (topics.some((t) => ['security', 'cybersecurity', 'cryptography', 'auth', 'jwt', 'oauth'].includes(t)) ||
          name.includes('auth') || desc.includes('jwt')) {
        categories.add('Cybersecurity');
      }
      // Blockchain
      if (topics.some((t) => ['blockchain', 'ethereum', 'solidity', 'smart-contracts', 'web3'].includes(t)) ||
          lang === 'solidity') {
        categories.add('Blockchain');
      }
    });

    const categoriesCount = categories.size;
    const projectDiversity = Math.min(100, 30 + (categoriesCount * 15));

    // 5. Calculate Final Verified Developer Score (VDS) using new weights:
    // Skill Proficiency     20%
    // Repository Complexity 20%
    // Contribution Score    20%
    // Activity Score        15%
    // Trust Score           15%
    // Project Diversity     5%
    // AI Audit Score        5%
    const vds = Math.round(
      (skillScore * 0.20) +
      (avgComplexity * 0.20) +
      (avgContribution * 0.20) +
      (finalActivityScore * 0.15) +
      (finalTrustScore * 0.15) +
      (projectDiversity * 0.05) +
      (avgAiAudit * 0.05)
    );

    // Rank & Grade Mapping
    let grade = 'Beginner Developer';
    let rank = 'Beginner Developer';
    if (vds >= 90) {
      grade = 'A+';
      rank = 'Elite Developer';
    } else if (vds >= 80) {
      grade = 'A';
      rank = 'Advanced Developer';
    } else if (vds >= 70) {
      grade = 'B';
      rank = 'Skilled Developer';
    } else if (vds >= 60) {
      grade = 'C';
      rank = 'Intermediate Developer';
    } else {
      grade = 'D';
      rank = 'Beginner Developer';
    }

    const metricsData = {
      vds,
      grade,
      rank,
      skillScore,
      contributionScore: avgContribution,
      trustScore: finalTrustScore,
      repositoryComplexity: avgComplexity,
      activityScore: finalActivityScore,
      projectDiversity,
      aiAuditScore: avgAiAudit,
      commitQualityScore: avgCommitQuality,
      ownershipScore: avgOwnership,
    };

    // Save metrics in DB
    try {
      await this.prisma.developerMetrics.upsert({
        where: { userId },
        update: metricsData,
        create: {
          userId,
          ...metricsData,
        },
      });
      this.logger.log(`Successfully stored VDS metrics in DB for ${username}. VDS: ${vds}`);
    } catch (dbErr) {
      this.logger.warn(`Failed to store developer metrics in DB: ${dbErr.message}`);
    }

    // Update Fallback Cache
    this.mockMetrics.set(lowerUsername, metricsData);
    this.mockRepoAnalyses.set(lowerUsername, analyses);

    return {
      metrics: metricsData,
      analyses,
    };
  }

  async getMetricsByUsername(username: string): Promise<any | null> {
    const lowerUsername = username.toLowerCase();
    try {
      const user = await this.prisma.user.findUnique({
        where: { username: lowerUsername },
        include: {
          metrics: true,
          repositories: {
            include: {
              contributionAnalysis: true,
            },
          },
        },
      });

      if (user && user.metrics) {
        return {
          username: user.username,
          metrics: user.metrics,
          repositories: user.repositories.map((r) => ({
            id: r.id,
            name: r.name,
            fullName: r.fullName,
            isFork: r.isFork,
            complexityScore: r.complexityScore,
            contributionAnalysis: r.contributionAnalysis,
          })),
        };
      }
    } catch (dbErr) {
      this.logger.warn(`Prisma failed reading metrics: ${dbErr.message}`);
    }

    // In-memory fallback lookup
    const cachedMetrics = this.mockMetrics.get(lowerUsername);
    if (cachedMetrics) {
      const cachedAnalyses = this.mockRepoAnalyses.get(lowerUsername) || [];
      return {
        username: lowerUsername,
        metrics: cachedMetrics,
        repositories: cachedAnalyses.map((a: any) => ({
          id: a.repoId,
          name: a.repoName,
          fullName: `${lowerUsername}/${a.repoName}`,
          isFork: a.isFork,
          complexityScore: a.complexityScore,
          contributionAnalysis: a.contributionAnalysis,
        })),
      };
    }

    return null;
  }

  async getVdsByUsername(username: string): Promise<any | null> {
    const lowerUsername = username.toLowerCase();
    try {
      const user = await this.prisma.user.findUnique({
        where: { username: lowerUsername },
        include: {
          metrics: true,
        },
      });

      if (user && user.metrics) {
        return {
          vds: user.metrics.vds,
          grade: user.metrics.grade,
          rank: user.metrics.rank,
          breakdown: {
            skillScore: user.metrics.skillScore,
            contributionScore: user.metrics.contributionScore,
            trustScore: user.metrics.trustScore,
            repositoryComplexity: user.metrics.repositoryComplexity,
            activityScore: user.metrics.activityScore,
            projectDiversity: user.metrics.projectDiversity,
            aiAuditScore: user.metrics.aiAuditScore,
            commitQualityScore: user.metrics.commitQualityScore,
            ownershipScore: user.metrics.ownershipScore,
          },
        };
      }
    } catch (dbErr) {
      this.logger.warn(`Prisma failed reading VDS: ${dbErr.message}`);
    }

    const cachedMetrics = this.mockMetrics.get(lowerUsername);
    if (cachedMetrics) {
      return {
        vds: cachedMetrics.vds,
        grade: cachedMetrics.grade,
        rank: cachedMetrics.rank,
        breakdown: {
          skillScore: cachedMetrics.skillScore,
          contributionScore: cachedMetrics.contributionScore,
          trustScore: cachedMetrics.trustScore,
          repositoryComplexity: cachedMetrics.repositoryComplexity,
          activityScore: cachedMetrics.activityScore,
          projectDiversity: cachedMetrics.projectDiversity,
          aiAuditScore: cachedMetrics.aiAuditScore,
          commitQualityScore: cachedMetrics.commitQualityScore,
          ownershipScore: cachedMetrics.ownershipScore,
        },
      };
    }

    return null;
  }
}
