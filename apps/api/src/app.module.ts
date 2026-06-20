import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { RepositoriesModule } from './repositories/repositories.module';
import { VerificationModule } from './verification/verification.module';
import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';
import { ReportsModule } from './reports/reports.module';
import { GithubModule } from './github/github.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    RepositoriesModule,
    VerificationModule,
    UsersModule,
    ReportsModule,
    GithubModule
  ],
})
export class AppModule {}

