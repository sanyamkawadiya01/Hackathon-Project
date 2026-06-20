import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { GithubApiService } from './github-api.service';
import { SkillExtractorService } from './skill-extractor.service';
import { ScoringService } from './scoring.service';
import { RepositoriesModule } from '../repositories/repositories.module';

@Module({
  imports: [RepositoriesModule],
  controllers: [UsersController],
  providers: [UsersService, SkillExtractorService, ScoringService],
  exports: [UsersService, SkillExtractorService, ScoringService],
})
export class UsersModule {}

