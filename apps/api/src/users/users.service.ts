import { Injectable, Logger } from '@nestjs/common';
import { GithubApiService } from './github-api.service';
import { PrismaService } from '../database/prisma.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { SkillExtractorService } from './skill-extractor.service';
import { ScoringService } from './scoring.service';
import * as crypto from 'crypto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  // In-memory fallbacks when database is offline/not configured
  private mockUsers = new Map<string, any>();
  private mockRepos = new Map<string, any[]>();

  constructor(
    private readonly githubApiService: GithubApiService,
    private readonly prisma: PrismaService,
    private readonly repositoriesService: RepositoriesService,
    private readonly skillExtractorService: SkillExtractorService,
    private readonly scoringService: ScoringService
  ) {}

  async analyzeUser(username: string) {
    this.logger.log(`Starting analysis for user: ${username}`);

    // 1. Fetch GitHub Profile
    const profile = await this.githubApiService.getProfile(username);

    // 2. Fetch All Public Repositories (excluding forks)
    const githubRepos = await this.githubApiService.getRepositories(username);

    let dbUser: any = null;
    const dbRepos: any[] = [];
    const jobId = `job_${crypto.randomUUID().slice(0, 8)}`;

    try {
      // 3. Upsert User in Database
      dbUser = await this.prisma.user.upsert({
        where: { username: profile.username.toLowerCase() },
        update: {
          githubId: profile.id,
          name: profile.name,
          displayName: profile.name || profile.username,
          avatarUrl: profile.avatarUrl,
          bio: profile.bio,
          followers: profile.followers,
          following: profile.following,
          publicRepos: profile.publicRepos,
          updatedAt: new Date(),
        },
        create: {
          githubId: profile.id,
          username: profile.username.toLowerCase(),
          name: profile.name,
          displayName: profile.name || profile.username,
          avatarUrl: profile.avatarUrl,
          bio: profile.bio,
          followers: profile.followers,
          following: profile.following,
          publicRepos: profile.publicRepos,
        },
      });

      // 4. Upsert Repositories in Database
      for (const repo of githubRepos) {
        const upsertedRepo = await this.prisma.repository.upsert({
          where: { repositoryId: repo.id },
          update: {
            name: repo.name,
            fullName: repo.fullName,
            description: repo.description,
            language: repo.language,
            primaryLanguage: repo.language,
            stars: repo.stars,
            starsCount: repo.stars,
            forks: repo.forks,
            forksCount: repo.forks,
            topics: repo.topics,
          },
          create: {
            repositoryId: repo.id,
            userId: dbUser.id,
            name: repo.name,
            fullName: repo.fullName,
            description: repo.description,
            language: repo.language,
            primaryLanguage: repo.language,
            stars: repo.stars,
            starsCount: repo.stars,
            forks: repo.forks,
            forksCount: repo.forks,
            topics: repo.topics,
          },
        });
        dbRepos.push(upsertedRepo);
      }
    } catch (dbError) {
      this.logger.warn(`Database connection/query failed. Falling back to in-memory store. Error: ${dbError.message}`);
      
      // Setup mock in-memory fallback user
      const mockUserId = dbUser?.id || `user_${profile.id}`;
      dbUser = {
        id: mockUserId,
        githubId: profile.id,
        username: profile.username.toLowerCase(),
        name: profile.name,
        displayName: profile.name || profile.username,
        avatarUrl: profile.avatarUrl,
        bio: profile.bio,
        followers: profile.followers,
        following: profile.following,
        publicRepos: profile.publicRepos,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.mockUsers.set(profile.username.toLowerCase(), dbUser);

      // Setup mock in-memory fallback repositories
      const fallbackReposList: any[] = [];
      for (const repo of githubRepos) {
        const mockRepoId = `repo_${repo.id}`;
        const fallbackRepo = {
          id: mockRepoId,
          repositoryId: repo.id,
          userId: mockUserId,
          name: repo.name,
          fullName: repo.fullName,
          description: repo.description,
          language: repo.language,
          primaryLanguage: repo.language,
          stars: repo.stars,
          starsCount: repo.stars,
          forks: repo.forks,
          forksCount: repo.forks,
          topics: repo.topics,
          complexityScore: 0,
          createdAt: new Date().toISOString(),
        };
        fallbackReposList.push(fallbackRepo);
      }
      this.mockRepos.set(profile.username.toLowerCase(), fallbackReposList);
      dbRepos.push(...fallbackReposList);
    }

    // 5. Trigger Repository Analysis in background (Non-blocking)
    this.triggerBackgroundAnalysis(profile.username, dbRepos, dbUser.id);

    return {
      user: dbUser,
      repositories: dbRepos,
      analysisStatus: 'completed',
      jobId,
    };
  }

  async getUserByUsername(username: string) {
    const lowerUsername = username.toLowerCase();
    
    try {
      const user = await this.prisma.user.findUnique({
        where: { username: lowerUsername },
        include: {
          repositories: true,
          skills: {
            include: {
              skill: true
            }
          },
          achievements: {
            include: {
              achievement: true
            }
          }
        }
      });

      if (user) {
        return user;
      }
    } catch (dbError) {
      this.logger.warn(`Failed to query database for user ${username}: ${dbError.message}`);
    }

    // fallback query in memory
    const user = this.mockUsers.get(lowerUsername);
    if (user) {
      const repositories = this.mockRepos.get(lowerUsername) || [];
      return {
        ...user,
        repositories,
        skills: user.skills || [],
        achievements: [],
      };
    }

    return null;
  }

  private triggerBackgroundAnalysis(username: string, repos: any[], userId: string) {
    this.logger.log(`Queueing background repository analysis for ${repos.length} repos of ${username}`);
    
    // Process asynchronously to avoid blocking the main user analyze request
    Promise.resolve().then(async () => {
      for (const repo of repos) {
        try {
          this.logger.log(`Background analyzing repository: ${repo.fullName}`);
          
          // Call existing analyzer service
          const analysisReport = await this.repositoriesService.analyzeRepository(
            username,
            repo.name,
            userId
          );

          // Update complexityScore in database
          try {
            await this.prisma.repository.update({
              where: { id: repo.id },
              data: {
                complexityScore: analysisReport.complexityScore,
                lastAnalyzedAt: new Date(),
              },
            });
            this.logger.log(`Successfully saved analysis details to DB for ${repo.fullName}`);
          } catch (dbErr) {
            // Update in-memory fallback
            const memRepos = this.mockRepos.get(username.toLowerCase());
            if (memRepos) {
              const matched = memRepos.find(r => r.id === repo.id);
              if (matched) {
                matched.complexityScore = analysisReport.complexityScore;
                matched.lastAnalyzedAt = new Date().toISOString();
                matched.aiAudit = analysisReport.aiAudit;
                matched.commits = analysisReport.commits;
              }
            }
          }
        } catch (repoErr) {
          this.logger.error(`Failed to background analyze repository ${repo.fullName}: ${repoErr.message}`);
        }
      }
      this.logger.log(`Completed background repository analysis for ${username}`);

      // Extract user skills from repositories
      try {
        this.logger.log(`Triggering skill extraction for ${username}`);
        const extractedSkills = await this.skillExtractorService.extractSkills(username, repos);
        this.logger.log(`Extracted ${extractedSkills.length} skills for ${username}`);

        // Persist to PostgreSQL database (wrapped in try-catch to support fallback mode gracefully)
        try {
          for (const extSkill of extractedSkills) {
            // Upsert Skill reference record
            const dbSkill = await this.prisma.skill.upsert({
              where: { name: extSkill.name },
              update: {
                category: extSkill.category
              },
              create: {
                name: extSkill.name,
                category: extSkill.category
              }
            });

            // Upsert UserSkill mapping record
            await this.prisma.userSkill.upsert({
              where: {
                userId_skillId: {
                  userId: userId,
                  skillId: dbSkill.id
                }
              },
              update: {
                proficiencyScore: extSkill.confidence,
                linesWritten: BigInt(extSkill.linesWritten),
                projectsCount: extSkill.projectsCount
              },
              create: {
                userId: userId,
                skillId: dbSkill.id,
                proficiencyScore: extSkill.confidence,
                linesWritten: BigInt(extSkill.linesWritten),
                projectsCount: extSkill.projectsCount
              }
            });
          }
          this.logger.log(`Successfully persisted extracted skills to DB for ${username}`);
        } catch (dbErr) {
          this.logger.warn(`Database not connected or query failed while saving skills: ${dbErr.message}`);
        }

        // Cache skills in-memory fallback
        const lowerUser = username.toLowerCase();
        const userFallback = this.mockUsers.get(lowerUser);
        if (userFallback) {
          userFallback.skills = extractedSkills.map(s => ({
            proficiencyScore: s.confidence,
            linesWritten: s.linesWritten,
            projectsCount: s.projectsCount,
            skill: {
              name: s.name,
              category: s.category
            }
          }));
          this.mockUsers.set(lowerUser, userFallback);
        }
      } catch (extractorErr) {
        this.logger.error(`Skill extraction failed for ${username}: ${extractorErr.message}`);
      }

      // Trigger developer metrics & VDS calculation
      try {
        this.logger.log(`Triggering scoring metrics calculation for ${username}`);
        await this.scoringService.calculateAndStoreMetrics(username, userId);
        this.logger.log(`Successfully completed scoring metrics & VDS calculation for ${username}`);
      } catch (scoringErr) {
        this.logger.error(`Scoring metrics calculation failed for ${username}: ${scoringErr.message}`);
      }
    });
  }
}
