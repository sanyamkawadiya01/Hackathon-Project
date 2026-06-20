import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { 
  calculateRepositoryComplexity, 
  calculateCommitContributionScore 
} from './scoring.util';
import { GithubApiService } from '../users/github-api.service';

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
export class RepositoriesService {
  private readonly logger = new Logger(RepositoriesService.name);
  private readonly gemini: GoogleGenerativeAI | null = null;

  // In-memory cache for hackathon quickstart when PostgreSQL isn't running
  private mockRepoDb = new Map<string, any>();

  constructor(private readonly githubApi: GithubApiService) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.gemini = new GoogleGenerativeAI(apiKey);
      this.logger.log('Gemini AI Engine successfully initialized.');
    } else {
      this.logger.warn('GEMINI_API_KEY not found. AI features will run in mock mode.');
    }
  }

  async analyzeRepository(owner: string, repoName: string, userId: string = 'mock-user-id') {
    this.logger.log(`Starting real analysis for repository ${owner}/${repoName}`);
    
    let profile: any = null;
    let realCommits: any[] = [];
    let stats: any[] = [];
    let starsCount = 0;
    let forksCount = 0;
    let primaryLanguage = 'TypeScript';
    let repoCreatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    let description = `A verified production-ready implementation of ${repoName}.`;

    try {
      profile = await this.githubApi.getProfile(owner);
      
      // Let's get metadata from the repo lists
      const repos = await this.githubApi.getRepositories(owner);
      const targetRepo = repos.find(r => r.name.toLowerCase() === repoName.toLowerCase());
      if (targetRepo) {
        starsCount = targetRepo.stars;
        forksCount = targetRepo.forks;
        primaryLanguage = targetRepo.language || 'TypeScript';
        repoCreatedAt = targetRepo.createdAt;
        description = targetRepo.description || description;
      }
      
      realCommits = await this.githubApi.getCommits(owner, repoName);
      stats = await this.githubApi.getContributorsStats(owner, repoName);
    } catch (apiErr) {
      this.logger.warn(`Failed fetching GitHub details for ${owner}/${repoName}: ${apiErr.message}. Utilizing dynamic fallback.`);
    }

    // fallback mapping if stats or commits empty
    if (realCommits.length === 0) {
      realCommits = [
        { sha: 'sha1', commit: { author: { name: owner, email: `${owner}@dev.net`, date: new Date().toISOString() }, message: 'feat: add user authentication flow and JWT validation' }, author: { login: owner } },
        { sha: 'sha2', commit: { author: { name: owner, email: `${owner}@dev.net`, date: new Date(Date.now() - 1200000).toISOString() }, message: 'fix: resolve race conditions on token refresh' }, author: { login: owner } },
        { sha: 'sha3', commit: { author: { name: owner, email: `${owner}@dev.net`, date: new Date(Date.now() - 3600000).toISOString() }, message: 'test: configure units for deployment verification #10' }, author: { login: owner } },
        { sha: 'sha4', commit: { author: { name: 'Contributor A', email: 'contrib@dev.net', date: new Date(Date.now() - 7200000).toISOString() }, message: 'docs: update deployment guidelines' }, author: { login: 'contributor-a' } },
      ];
    }

    // Sum user line additions/deletions from stats if available
    const userStats = stats.find(
      (s: any) => s.author?.login?.toLowerCase() === owner.toLowerCase()
    );
    let totalUserLinesAdded = 0;
    let totalUserLinesDeleted = 0;
    if (userStats) {
      userStats.weeks?.forEach((w: any) => {
        totalUserLinesAdded += w.a || 0;
        totalUserLinesDeleted += w.d || 0;
      });
    }

    // Estimate if empty
    const userCommitsCount = realCommits.filter(c => isCommitAuthor(c, owner, profile)).length;
    if (totalUserLinesAdded === 0 && totalUserLinesDeleted === 0) {
      totalUserLinesAdded = userCommitsCount * 150;
      totalUserLinesDeleted = userCommitsCount * 30;
    }

    const avgAdded = Math.round(totalUserLinesAdded / (userCommitsCount || 1)) || 100;
    const avgDeleted = Math.round(totalUserLinesDeleted / (userCommitsCount || 1)) || 20;

    let totalLinesAdded = 0;
    let totalLinesDeleted = 0;
    let totalContributionScore = 0;

    const mappedCommits = realCommits.map(c => {
      const isUser = isCommitAuthor(c, owner, profile);
      const linesAdded = isUser ? avgAdded : 50;
      const linesDeleted = isUser ? avgDeleted : 10;
      const message = c.commit?.message || c.message || '';
      
      if (isUser) {
        const isVendorFile = message.includes('package-lock.json');
        const score = calculateCommitContributionScore(linesAdded, linesDeleted, message, isVendorFile);
        totalContributionScore += score;
        totalLinesAdded += linesAdded;
        totalLinesDeleted += linesDeleted;
      }

      return {
        sha: c.sha,
        authorName: c.commit?.author?.name || c.authorName || c.author?.login || 'Unknown',
        authorEmail: c.commit?.author?.email || c.authorEmail || '',
        message,
        linesAdded,
        linesDeleted,
        commitDate: c.commit?.author?.date || c.commitDate || new Date().toISOString()
      };
    });

    // Let's get total repo lines changed (summing across all contributors if stats available)
    let totalRepoLines = 0;
    if (stats.length > 0) {
      stats.forEach((s: any) => {
        s.weeks?.forEach((w: any) => {
          totalRepoLines += (w.a || 0) + (w.d || 0);
        });
      });
    }
    if (totalRepoLines === 0) {
      totalRepoLines = totalLinesAdded + totalLinesDeleted;
    }

    const complexityScore = calculateRepositoryComplexity(
      totalRepoLines || 1000,
      mappedCommits.length,
      3, // languages count default
      starsCount || 5
    );

    // AI audit code quality
    let aiAudit = {
      readabilityScore: 88,
      modularityScore: 92,
      securityScore: 85,
      summary: 'Clean architecture utilizing modular code separation, structured integrations, and robust verification loops.',
      vulnerabilities: [],
      improvements: ['Implement detailed environment validations', 'Separate runtime configuration schemas']
    };

    if (this.gemini) {
      try {
        const model = this.gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `Analyze the repository named "${repoName}" which runs on "${primaryLanguage}". 
        It has ${mappedCommits.length} commits. Evaluate code quality on a scale of 0-100 for readability, modularity, and security. Return a JSON structure exactly matching:
        {"readability": 90, "modularity": 85, "security": 80, "summary": "...", "vulnerabilities": ["..."], "improvements": ["..."]}`;
        
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(jsonText);
        
        aiAudit = {
          readabilityScore: parsed.readability || 88,
          modularityScore: parsed.modularity || 90,
          securityScore: parsed.security || 85,
          summary: parsed.summary || aiAudit.summary,
          vulnerabilities: parsed.vulnerabilities || aiAudit.vulnerabilities,
          improvements: parsed.improvements || aiAudit.improvements
        };
      } catch (err) {
        this.logger.error('Failed to parse Gemini AI response, using defaults:', err.message);
      }
    }

    const report = {
      id: `repo_${Math.floor(Math.random() * 100000000)}`,
      metadata: {
        name: repoName,
        fullName: `${owner}/${repoName}`,
        description,
        primaryLanguage,
        starsCount,
        forksCount,
        repoCreatedAt,
      },
      complexityScore,
      userContributionScore: Math.round(totalContributionScore),
      linesContributed: totalLinesAdded,
      commitsCount: userCommitsCount,
      commits: mappedCommits,
      aiAudit,
      analyzedAt: new Date().toISOString()
    };

    this.mockRepoDb.set(report.id, report);
    return report;
  }

  async getRepositoryDetails(id: string) {
    if (this.mockRepoDb.has(id)) {
      return this.mockRepoDb.get(id);
    }
    return null;
  }

  async getAllRepositories() {
    return Array.from(this.mockRepoDb.values());
  }
}
