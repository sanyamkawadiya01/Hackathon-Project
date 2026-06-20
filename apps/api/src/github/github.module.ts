import { Module, Global } from '@nestjs/common';
import { GithubApiService } from '../users/github-api.service';

@Global()
@Module({
  providers: [GithubApiService],
  exports: [GithubApiService],
})
export class GithubModule {}
