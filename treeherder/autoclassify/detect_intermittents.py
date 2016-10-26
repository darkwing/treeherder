import logging

from treeherder.model.derived import JobsModel
from treeherder.model.models import (Job,
                                     Matcher,
                                     TextLogError)

from .autoclassify import (AUTOCLASSIFY_CUTOFF_RATIO,
                           match_errors)

logger = logging.getLogger(__name__)


def detect(test_job):
    with JobsModel(test_job.repository.name) as jm:
        ds_jobs = jm.get_job_repeats(test_job.guid)
        jobs_by_guid = {item["job_guid"]: item for item in ds_jobs}
        jobs = Job.objects.filter(repository=test_job.repository,
                                  guid__in=jobs_by_guid.keys())
        assert len(jobs) == len(ds_jobs)
        for item in jobs:
            guid = item.guid
            jobs_by_guid[guid] = (item, jobs_by_guid[guid])
        jobs = jobs_by_guid.values()

    # The approach here is currently to look for new intermittents to add, one at a time
    # and then rerun the matching on other jobs
    # TODO: limit the possible matches to those that have just been added
    if len(jobs) <= 1:
        logger.debug("Too few jobs in the current set")
        return

    # For now conservatively assume that we can only mark new intermittents if
    # one run in the current set fully passes
    if not any(ds_job["result"] == "success" for _, ds_job in jobs):
        logger.debug("No successful jobs to compare against")
        return

    errors_by_job = TextLogError.objects.for_jobs(*(job for job, _ in jobs))

    for job, ds_job in jobs:
        logger.info("Looking for new intermittents from job %s" % (job.guid,))
        job_errors = errors_by_job.get(job)
        if job_errors is None:
            logger.debug("Job has no errors")
            continue

        new_matches = {}

        unmatched_lines = [item for item in job_errors if
                           not item.classified_failures.count()]

        for detector in Matcher.objects.registered_detectors():
            unmatched_lines = [item for item in unmatched_lines if item.id not in new_matches]

            if unmatched_lines:
                logger.debug("Found %i unmatched lines" % len(unmatched_lines))
            detected_indicies = detector(unmatched_lines)

            for index in detected_indicies:
                text_log_error = unmatched_lines[index]
                classification, match = text_log_error.set_classification(detector.db_object)
                new_matches[text_log_error.id] = (classification, match)

        if new_matches:
            errors = [item for item in job_errors if item.id in new_matches]
            for text_log_error in errors:
                classification, match = new_matches[text_log_error.id]
                if match.score > AUTOCLASSIFY_CUTOFF_RATIO:
                    text_log_error.mark_best_classification(classification)
            for job, ds_job in jobs:
                if job == test_job:
                    continue
                logger.debug("Trying rematch on job %s" % (job.guid))
                match_errors(job)
