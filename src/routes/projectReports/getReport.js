/* eslint-disable no-unused-vars */
import config from 'config';
import _ from 'lodash';

import { middleware as tcMiddleware } from 'tc-core-library-js';
import models from '../../models';
import LookApi from './LookRun';
import mock from './mock';
import util from '../../util';
import { PROJECT_MEMBER_MANAGER_ROLES } from '../../constants';

const permissions = tcMiddleware.permissions;


module.exports = [
  permissions('project.view'),
  async (req, res, next) => {
    const projectId = Number(req.params.projectId);
    const reportName = req.query.reportName;

    if (config.lookerConfig.USE_MOCK === true) {
      req.log.info('using mock');
      // using mock
      return mock(projectId, reportName, req, res);
      // res.status(200).json(util.wrapResponse(req.id, project));
    }
    const lookApi = new LookApi(req.log);
    const project = await models.Project.find({
      where: { id: projectId },
      attributes: ['directProjectId'],
      raw: true,
    });
    const directProjectId = _.get(project, 'directProjectId');
    if (!directProjectId) {
      return res.status(400).send('Direct Project not linked');
    }

    try {
      // check if auth user has acecss to this project
      const isManager = util.hasRoles(req, PROJECT_MEMBER_MANAGER_ROLES);
      // pick the report based on its name
      let result = {};
      switch (reportName) {
        case 'summary':
          result = await lookApi.findProjectRegSubmissions(directProjectId);
          break;
        case 'projectBudget':
          result = await lookApi.findProjectBudget(projectId, isManager);
          break;
        default:
          return res.status(404).send('Report not found');
      }

      req.log.debug(result);
      return res.status(200).json(util.wrapResponse(req.id, result));
    } catch (err) {
      req.log.error(err);
      return res.status(500).send(err.toString());
    }
  },
];
