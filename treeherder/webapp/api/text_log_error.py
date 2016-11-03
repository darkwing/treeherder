from django.db import transaction
from rest_framework import viewsets
from rest_framework.response import Response
from rest_framework.status import (HTTP_200_OK,
                                   HTTP_400_BAD_REQUEST,
                                   HTTP_404_NOT_FOUND)

from treeherder.model.models import (ClassifiedFailure,
                                     TextLogError)
from treeherder.webapp.api import (pagination,
                                   serializers)
from treeherder.webapp.api.utils import as_dict


class TextLogErrorViewSet(viewsets.ModelViewSet):
    serializer_class = serializers.TextLogErrorSerializer
    queryset = TextLogError.objects.prefetch_related("matches", "matches__matcher").all()
    pagination_class = pagination.IdPagination

    @transaction.atomic
    def _update(self, data, user, many=True):
        ids = []
        error_line_ids = set()
        classification_ids = set()
        bug_number_classifications = {}

        for item in data:
            line_id = int(item.get("id"))
            if line_id is None:
                return "No text log error id provided", HTTP_400_BAD_REQUEST

            error_line_ids.add(line_id)

            if "best_classification" not in item:
                return "No classification id provided", HTTP_400_BAD_REQUEST

            classification_id = item.get("best_classification")

            bug_number = None
            if classification_id is not None:
                classification_ids.add(classification_id)
            else:
                bug_number = item.get("bug_number")

            if bug_number not in bug_number_classifications:
                bug_number_classifications[bug_number] = ClassifiedFailure.get_or_create(
                    bug_number=bug_number)

            ids.append((line_id, classification_id, bug_number))

        error_lines = as_dict(
            TextLogError.objects
            .prefetch_related('classified_failures')
            .filter(id__in=error_line_ids), "id")

        if len(error_lines) != len(error_line_ids):
            missing = error_line_ids - set(error_lines.keys())
            return ("No text log error with id: {0}".format(", ".join(missing)),
                    HTTP_404_NOT_FOUND)

        classifications = as_dict(
            ClassifiedFailure.objects.filter(id__in=classification_ids), "id")

        if len(classifications) != len(classification_ids):
            missing = classification_ids - set(classifications.keys())
            return ("No classification with id: {0}".format(", ".join(missing)),
                    HTTP_404_NOT_FOUND)

        for line_id, classification_id, bug_number in ids:
            error_line = error_lines[line_id]
            if classification_id is not None:
                classification = classifications[classification_id]
            elif bug_number is not None:
                classification = bug_number_classifications[bug_number]
            else:
                classification = None

            error_line.mark_best_classification_verified(classification)
            error_line.job.update_after_verification(user)

        # Force failure line to be reloaded, including .classified_failures
        rv = (TextLogError.objects
              .prefetch_related('classified_failures')
              .filter(id__in=error_line_ids))

        if not many:
            rv = rv[0]

        return (serializers.TextLogErrorSerializer(rv, many=many).data,
                HTTP_200_OK)

    def update(self, request, pk=None):
        data = {"id": pk}
        for k, v in request.data.iteritems():
            if k not in data:
                data[k] = v

        body, status = self._update([data], request.user, many=False)
        return Response(body, status=status)

    def update_many(self, request):
        body, status = self._update(request.data, request.user, many=True)

        if status == HTTP_404_NOT_FOUND:
            # 404 doesn't make sense for updating many since the path is always
            # valid, so if we get an invalid id instead return 400
            status = HTTP_400_BAD_REQUEST

        return Response(body, status=status)
