import { Controller, Get, Param, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get(':username')
  async getReport(@Param('username') username: string, @Res() res: Response) {
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Invalid GitHub username',
      });
    }

    try {
      const data = await this.reportsService.getReportData(username.trim());
      return res.status(HttpStatus.OK).json({
        success: true,
        data,
      });
    } catch (error) {
      const status = error.status || HttpStatus.INTERNAL_SERVER_ERROR;
      return res.status(status).json({
        error: error.message || 'Failed to compile report details',
      });
    }
  }

  @Get(':username/download')
  async downloadReport(@Param('username') username: string, @Res() res: Response) {
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Invalid GitHub username',
      });
    }

    await this.reportsService.generatePdfReport(username.trim(), res);
  }
}
