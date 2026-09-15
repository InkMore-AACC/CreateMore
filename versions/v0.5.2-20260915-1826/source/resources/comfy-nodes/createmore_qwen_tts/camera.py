class CreateMoreCameraPrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {
            'azimuth': (['front view', 'front-right quarter view', 'right side view', 'back-right quarter view', 'back view', 'back-left quarter view', 'left side view', 'front-left quarter view'],),
            'elevation': (['low-angle shot', 'eye-level shot', 'elevated shot', 'high-angle shot'],),
            'distance': (['close-up', 'medium shot', 'wide shot'],),
            'extra': ('STRING', {'multiline': True, 'default': ''}),
        }}
    RETURN_TYPES = ('STRING',)
    FUNCTION = 'compose'
    CATEGORY = 'CreateMore/Image'

    def compose(self, azimuth, elevation, distance, extra):
        return (f'<sks> {azimuth} {elevation} {distance}. {extra}',)
