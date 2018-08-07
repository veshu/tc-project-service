/**
 * API to update a milestone
 */
import validate from 'express-validation';
import _ from 'lodash';
import moment from 'moment';
import Joi from 'joi';
import Sequelize from 'sequelize';
import { middleware as tcMiddleware } from 'tc-core-library-js';
import util from '../../util';
import validateTimeline from '../../middlewares/validateTimeline';
import { EVENT, MILESTONE_STATUS } from '../../constants';
import models from '../../models';

const permissions = tcMiddleware.permissions;

/**
 * Cascades endDate/completionDate changes to all milestones with a greater order than the given one.
 * @param {Object} originalMilestone the original milestone that was updated
 * @param {Object} updatedMilestone the milestone that was updated
 * @returns {Promise<void>} a promise that resolves to the last found milestone. If no milestone exists with an
 * order greater than the passed <b>updatedMilestone</b>, the promise will resolve to the passed
 * <b>updatedMilestone</b>
 */
function updateComingMilestones(originalMilestone, updatedMilestone) {
  // flag to indicate if the milestone in picture, is updated for completionDate field or not
  const completionDateChanged = !_.isEqual(originalMilestone.completionDate, updatedMilestone.completionDate);
  return models.Milestone.findAll({
    where: {
      timelineId: updatedMilestone.timelineId,
      order: { $gt: updatedMilestone.order },
    },
  }).then((affectedMilestones) => {
    const comingMilestones = _.sortBy(affectedMilestones, 'order');
    let startDate = moment.utc(updatedMilestone.completionDate
      ? updatedMilestone.completionDate
      : updatedMilestone.endDate).add(1, 'days').toDate();
    let firstMilestoneFound = false;
    const promises = _.map(comingMilestones, (_milestone) => {
      const milestone = _milestone;

      // Update the milestone startDate if different than the iterated startDate
      if (!_.isEqual(milestone.startDate, startDate)) {
        milestone.startDate = startDate;
        milestone.updatedBy = updatedMilestone.updatedBy;
      }

      // Calculate the endDate, and update it if different
      const endDate = moment.utc(startDate).add(milestone.duration - 1, 'days').toDate();
      if (!_.isEqual(milestone.endDate, endDate)) {
        milestone.endDate = endDate;
        milestone.updatedBy = updatedMilestone.updatedBy;
      }

      // if completionDate is alerted, update status of the first non hidden milestone after the current one
      if (!firstMilestoneFound && completionDateChanged && !milestone.hidden) {
        // activate next milestone
        milestone.status = MILESTONE_STATUS.ACTIVE;
        firstMilestoneFound = true;
      }

      // Set the next startDate value to the next day after completionDate if present or the endDate
      startDate = moment.utc(milestone.completionDate
        ? milestone.completionDate
        : milestone.endDate).add(1, 'days').toDate();
      return milestone.save();
    });

    // Resolve promise to the last updated milestone, or to the passed in updatedMilestone
    return Promise.all(promises).then(updatedMilestones => updatedMilestones.pop() || updatedMilestone);
  });
}

const schema = {
  params: {
    timelineId: Joi.number().integer().positive().required(),
    milestoneId: Joi.number().integer().positive().required(),
  },
  body: {
    param: Joi.object().keys({
      id: Joi.any().strip(),
      name: Joi.string().max(255).optional(),
      description: Joi.string().max(255),
      duration: Joi.number().integer().min(1).optional(),
      startDate: Joi.any().forbidden(),
      endDate: Joi.any().forbidden(),
      completionDate: Joi.date().allow(null),
      status: Joi.string().max(45).optional(),
      type: Joi.string().max(45).optional(),
      details: Joi.object(),
      order: Joi.number().integer().optional(),
      plannedText: Joi.string().max(512).optional(),
      activeText: Joi.string().max(512).optional(),
      completedText: Joi.string().max(512).optional(),
      blockedText: Joi.string().max(512).optional(),
      hidden: Joi.boolean().optional(),
      createdAt: Joi.any().strip(),
      updatedAt: Joi.any().strip(),
      deletedAt: Joi.any().strip(),
      createdBy: Joi.any().strip(),
      updatedBy: Joi.any().strip(),
      deletedBy: Joi.any().strip(),
    }).required(),
  },
};

module.exports = [
  validate(schema),
  // Validate and get projectId from the timelineId param,
  // and set to request params for checking by the permissions middleware
  validateTimeline.validateTimelineIdParam,
  permissions('milestone.edit'),
  (req, res, next) => {
    const where = {
      timelineId: req.params.timelineId,
      id: req.params.milestoneId,
    };
    const entityToUpdate = _.assign(req.body.param, {
      updatedBy: req.authUser.userId,
      timelineId: req.params.timelineId,
    });

    const timeline = req.timeline;

    let original;
    let updated;

    return models.sequelize.transaction(() =>
      // Find the milestone
      models.Milestone.findOne({ where })
        .then((milestone) => {
          // Not found
          if (!milestone) {
            const apiErr = new Error(`Milestone not found for milestone id ${req.params.milestoneId}`);
            apiErr.status = 404;
            return Promise.reject(apiErr);
          }

          if (entityToUpdate.completionDate && entityToUpdate.completionDate < milestone.startDate) {
            const apiErr = new Error('The milestone completionDate should be greater or equal than the startDate.');
            apiErr.status = 422;
            return Promise.reject(apiErr);
          }

          original = _.omit(milestone.toJSON(), ['deletedAt', 'deletedBy']);
          const durationChanged = entityToUpdate.duration && entityToUpdate.duration !== milestone.duration;
          const statusChanged = entityToUpdate.status && entityToUpdate.status !== milestone.status;
          const completionDateChanged = entityToUpdate.completionDate
            && !_.isEqual(milestone.completionDate, entityToUpdate.completionDate);
          const today = moment.utc().hours(0).minutes(0).seconds(0)
            .milliseconds(0);

          // Merge JSON fields
          entityToUpdate.details = util.mergeJsonObjects(milestone.details, entityToUpdate.details);

          if (durationChanged) {
            entityToUpdate.endDate = moment.utc(milestone.startDate).add(entityToUpdate.duration - 1, 'days').toDate();
          }

          // if status has changed
          if (statusChanged) {
            // if status has changed to be completed, set the compeltionDate if not provided
            if (entityToUpdate.status === MILESTONE_STATUS.COMPLETED) {
              entityToUpdate.completionDate = entityToUpdate.completionDate ? entityToUpdate.completionDate : today;
            }
            // if status has changed to be active, set the startDate to today
            if (entityToUpdate.status === MILESTONE_STATUS.ACTIVE) {
              entityToUpdate.startDate = today;
            }
          }

          // if completionDate has changed
          if (!statusChanged && completionDateChanged) {
            entityToUpdate.status = MILESTONE_STATUS.COMPLETED;
          }

          // Update
          return milestone.update(entityToUpdate);
        })
        .then((updatedMilestone) => {
          // Omit deletedAt, deletedBy
          updated = _.omit(updatedMilestone.toJSON(), 'deletedAt', 'deletedBy');

          // Update order of the other milestones only if the order was changed
          if (original.order === updated.order) {
            return Promise.resolve();
          }

          return models.Milestone.count({
            where: {
              timelineId: updated.timelineId,
              id: { $ne: updated.id },
              order: updated.order,
            },
          })
            .then((count) => {
              if (count === 0) {
                return Promise.resolve();
              }

              // Increase the order from M to K: if there is an item with order K,
              // orders from M+1 to K should be made M to K-1
              if (original.order < updated.order) {
                return models.Milestone.update({ order: Sequelize.literal('"order" - 1') }, {
                  where: {
                    timelineId: updated.timelineId,
                    id: { $ne: updated.id },
                    order: { $between: [original.order + 1, updated.order] },
                  },
                });
              }

              // Decrease the order from M to K: if there is an item with order K,
              // orders from K to M-1 should be made K+1 to M
              return models.Milestone.update({ order: Sequelize.literal('"order" + 1') }, {
                where: {
                  timelineId: updated.timelineId,
                  id: { $ne: updated.id },
                  order: { $between: [updated.order, original.order - 1] },
                },
              });
            });
        })
        .then(() => {
          // Update dates of the other milestones only if the completionDate or the duration changed
          if (!_.isEqual(original.completionDate, updated.completionDate) || original.duration !== updated.duration) {
            return updateComingMilestones(original, updated)
              .then((lastTimelineMilestone) => {
                if (!_.isEqual(lastTimelineMilestone.endDate, timeline.endDate)) {
                  timeline.endDate = lastTimelineMilestone.endDate;
                  timeline.updatedBy = lastTimelineMilestone.updatedBy;
                  return timeline.save();
                }
                return Promise.resolve();
              });
          }
          return Promise.resolve();
        }),
    )
    .then(() => {
      // Send event to bus
      req.log.debug('Sending event to RabbitMQ bus for milestone %d', updated.id);
      req.app.services.pubsub.publish(EVENT.ROUTING_KEY.MILESTONE_UPDATED,
        { original, updated },
        { correlationId: req.id },
      );

      // Do not send events for the the other milestones (updated order) here,
      // because it will make 'version conflict' error in ES.
      // The order of the other milestones need to be updated in the MILESTONE_UPDATED event above

      // Write to response
      res.json(util.wrapResponse(req.id, updated));
      return Promise.resolve();
    })
    .catch(next);
  },
];
